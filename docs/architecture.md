# Architecture

How the program is put together, and the two coordinate decisions that everything else
follows from. [README.md](../README.md) has the usage path; this is the layer under it.

```
Kinect v2 ──USB3──▶ native/grabber ──framed stdout──▶ server/index.js ──WebSocket──▶ web/main.js
                    (libfreenect2 +                   (fan-out, drop-to-latest)     (GPU unprojection,
                     OpenCL depth,                                                   217k points +
                     TurboJPEG colour)                                               surface memory)
```

A native grabber pulls depth and registered colour from
[libfreenect2](https://github.com/OpenKinect/libfreenect2), a Node server fans the frames
out over WebSocket, and a Three.js viewer unprojects them on the GPU using the sensor's own
intrinsics. On top sit a recorder, a take library that reconciles between two machines, a
keyframe editor with a retime curve, and a render queue that exports through ffmpeg.

Depth and colour are captured on separate listeners: the colour camera halves to 15fps in
dim light while depth stays at 30, and a synced listener would throw away every other depth
frame waiting for it. Depth runs at its own rate and reuses the most recent colour, at worst
one interval stale. The grabber logs both counts, and beside them the frames libfreenect2
handed over having already marked its own solve as failed —
`600 frames (293 colour, 0 bad depth, 0 bad colour)`. A lagging colour rate is the one thing
that explains a stale-looking image, and the two refusal counts are the one thing that
separates a machine whose GPU readback is failing from a degraded USB link: a refused depth
frame does not advance the frame count, so the rate drops either way and only these say which.
They are printed whether or not they are zero, because a build that has stopped counting and a
run with nothing to count would otherwise read identically.

## The four surfaces

The reasoning behind each one lives in the comments of the file that implements it.

**The viewer** is the live cloud, and the recorder shares the surface because arming a take
is something you do while watching.

**The recorder** waits for the sensor's hello, then streams frames straight to disk in the
wire's own framing, so a capture is byte-identical to what the grabber emitted. It refuses a
take it lacks the disk space to finish. Its preview clip range is cosmetic and deliberately
cannot reach the grabber's `--min-depth`/`--max-depth`, which clip on the GPU before a frame
exists.

**The library** joins takes across two machines on content hash rather than filename,
because two machines can hold genuinely different takes under one name. Takes can be pulled
down, and a copy reclaimed on the node after the local one is re-hashed. Warnings
(truncated, no sensor hello, no whole frame, still recording) are badges over the poster
with their sentence in the ⋯ menu, because the node's panel has no hover.

**Renaming moves a label and never a reference.** Each of a project's clips records its take
as `{id, hash}` and the loader resolves the hash against the library listing, so a rename
carries the capture, its marks and its index to a new name and every project still opens —
the id it comes back holding is the one the take is under now. Two renames aimed at one
name are refused by the kernel rather than by a stale reading, so the loser keeps its
footage.

**Showing a take in the file manager is the only route that starts a process**, so it sits
behind the same origin gate as everything else with a consequence, is refused unless the
browser is on the server's machine, and is refused for the take being recorded, since a file
manager stats, indexes and previews the file the recorder is writing to.

**The editor** keyframes the camera through the recorded volume on its own track and the
look on others, with a retime curve mapping program time onto source time. Seeking to a
frame and playing to that frame produce the same image, which `tools/timeline-check.mjs`
proves.

**The render queue** produces video from finished edits, claimed by a worker pinned to the
renderer class it will draw with. [Get a video out](../README.md#5-get-a-video-out) has the
rest.

## The effect store

The look is not one program. Every effect is a package — a manifest and the GLSL chunks it
splices into the shaders — and the page assembles both point-cloud programs, the grade pass, the
mosh pass, the parameter registry and the panel out of whatever the store holds. `server/effect-store.js` serves
them and `web/shader-assembly.js` joins them.

**Two roots, and the user's copy wins.** `effects-builtin/` is what the build ships with and
nothing in this program writes into it; `effects/` is where an install lands. An id present in
both resolves from the user's, which *is* the fork mechanism: install a package under a shipped
id and it shadows the shipped one, delete that copy and the shipped one answers again. The
shipped set is therefore always available to fall back to, which is why removing a builtin
nothing forks is refused rather than performed. It is the same shape the preset store uses, and
what makes it its own class rather than a fourth construction of that one is what is stored: a
package is a directory of files, so a revision has to be computed over the set and a read has to
say which files exist before a client can fetch them one at a time.

```
GET    /effects              { effects: [ every id either root holds, with its files and
                               revisions ], generation: how many times this store has changed }
GET    /effects/:id          one package: the parsed manifest, the file index, the revision
GET    /effects/:id/file/:n  one file's bytes, as text/plain
PUT    /effects/:id          { manifest, chunks: { <file>: <text> } }  installs into effects/
DELETE /effects/:id          removes the user's copy only
POST   /effect-refusals      { ids: [...], reason }  sets aside the user copies of packages a
                             page could not compile, and answers which it set aside and which
                             it skipped, with a reason for each. Deliberately not under
                             /effects/, because a literal segment there outranks :id and an
                             effect id is a directory name anybody can create
```

A revision is a hash of the bytes: `sha256` per file, and the package's own over the sorted
`name hash` lines. Never a re-serialisation — a manifest that round-trips through `JSON.parse`
is a different byte stream with the same meaning, and provenance is about bytes.

**The generation is beside the list because a hash of bytes cannot say that a change was
undone.** A client assembles a set out of one listing, a request per package and a request per
chunk, and the thing it has to be sure of is that all of those came from one revision of the
store — which it asks by listing again at the end and requiring the answer to be the one it
started from. Contents alone cannot answer it: install a fork and delete it again, which
restores the shipped package rather than removing anything, and every revision on both sides of
that pair is identical while the store answered as something else in between. A read straddling
it passes the comparison by construction, assembles a program out of two revisions, and records
the revision it opened with, so nothing later ever disagrees either. The counter is the store's
own history rather than its contents, which is the axis that pair moves along; it is bumped by
`install`, by `remove` and by a package set aside through `POST /effect-refusals`, and by nothing
else — the third is the same act as the first two from the store's point of view, a directory
appearing or leaving under an id, and a page that has just quarantined something it could not
compile has to be handed the working set on its next poll rather than the one it is blocked on. It
is not durable, because a restart makes the two listings disagree and the client retries.

**An install is atomic because a package is a directory.** The whole thing is written under
`<id>.<seq>.tmp`, any existing copy is renamed to `<id>.<seq>.old`, the new one is renamed in and
the old one deleted. Those suffixes carry a dot and an effect id may not, so a crashed install is
invisible to every read by the same rule that decides what an id is — and the next install of
that id sweeps what it left.

**Between those two renames the id resolves to nothing, and that window is the one place this
store can lose work.** A machine losing power there comes back with the only copy of the package
in its aside and nothing at the live id, which reads as an uninstall rather than as damage — so
the store puts it back when it is constructed, before anything can read it, and the sweep removes
an aside only while there is a live directory beside it to measure against. An uninstall renames
aside too, and its aside is named `<id>.<seq>.gone` for exactly this reason: one suffix per
intent, so "should this come back" is answered by the name rather than guessed at, and a recovery
that could not tell the two apart would undo somebody's uninstall on every restart.

**A package file is an ordinary file.** `effects/` is the one directory in this program a client
can write into, so the file route asks what a name *is* rather than what it points at — a symlink
planted there is refused whether or not it aims somewhere legitimate, which is a narrower rule
than the realpath-and-containment pair the static tree uses and needs no notion of where the roots
are.

What may be written at all is decided before any of it: the door in
`server/effect-door.js` runs the real assembler against the set that would exist after the
install, and a package that would not assemble, would bind a uniform no program declares or would
name an identifier this build has not got is refused with the reason and never reaches disk.
A parameter whose `def` or `max` is not on the step grid its own `min` anchors is refused there
too, and the door asks by running `snapScalar` — the arithmetic the registry snaps with — rather
than by describing it: a default the snap would move is a number the manifest states and the
program never holds, which makes an untouched effect read as modified from the first paint and
puts a `requires` entry for it into every document saved afterwards. The
alternative is a package that installs cleanly and breaks the *next* page load, where the only
evidence is a console nobody has open.

**And the same door is asked again of what is already on disk, at every start.** A package got
through it once, against the build that was running the day it was installed, and a fork outlives
the build it was made on: upgrade the program and the spine may have dropped or renamed a joint
that fork's GLSL names, or the builtin it shadows may have grown a parameter it does not carry.
Nothing about the fork changes and it goes on shadowing the upgraded builtin, so the page fetches
it and `assembleShaders` throws while `web/main.js` is still evaluating — no `__kinect`, neither
surface opening, and the machine that upgraded is the machine that stops working. So the store
re-runs `doorRefusal` and `forkRefusal` over every package in the *user* root, against this
build's spines; a package either of them now refuses is renamed to `<id>.<seq>.incompatible`,
which is invisible to every read by the rule the `.tmp` suffix relies on and is swept by nothing,
and the shipped package answers for that id again. Renamed and never deleted, because a fork is
authored work and "this build cannot use it" is not a reason to destroy it; announced in the log
with the door's own sentence, because an id that used to answer with somebody's fork and now
answers with the builtin is a change nobody asked for. Only the user root, because a builtin is
this build's own package and one this build cannot assemble is a broken build rather than a
migration.

Two things about *when* and *against what*, both of which were wrong in ways that quarantined
packages nothing was wrong with. The gate runs from inside `listen`'s callback rather than at
construction, because it renames directories and the port is what says this process is the one
entitled to: two servers on one effects root is two servers on one port, so the loser of the bind
exits having touched nothing. It is sound because everything the gate does is synchronous `fs` —
the socket is accepting by then, but a request handler is a callback on a later turn of the event
loop, so no route is ever answered out of a store that has not been gated. And each package is
doored against the builtins plus the packages already *validated* rather than against everything
on disk: the door assembles `[...beside, candidate]` and reports what fails under the candidate's
name, so one unusable fork used to make its innocent neighbours come back "does not assemble",
with the blame landing on whichever the walk reached first. The pass repeats while it is still
promoting packages, because a package may legitimately read another's varying and a single sweep
would refuse a pair this build's own install door accepts.

### Assembly: a spine with joints, and the chunks that fill them

`web/cloud-shader.js`, `web/grade-shader.js` and `web/mosh-shader.js` each export a **spine** —
verbatim GLSL segments with named joints between them — and `web/shader-assembly.js` concatenates
a spine with whatever the installed packages bring. Neither module imports anything and neither interpolates: a chunk's
text is spliced between two segments exactly as it arrived, because every transformation on the
way is a byte that could move without breaking a compile or showing in a picture anybody would
look twice at.

A joint is one of four kinds, and the kind decides what filling it means:

- a **stage** takes any number of chunks, concatenated by the `order` each declares — which is
  why two packages can both add uniforms to one declaration block;
- a **slot** takes at most one claimant and carries the text to use when nothing claims it, so a
  slot is a *replacement* and an uninstalled effect is exact identity by construction;
- a **service** is a value the spine computes under a gate its consumers generate, the condition
  built from each consumer's own `when` clause and joined in `gateOrder`, so a term that reads
  the value without joining the gate is inert rather than broken;
- **varyings** are generated from the packages' declarations in all three places at once — the
  `out` list, the `in` list and the initialisation — so one declaration is the only statement of
  the fact.

Joint names are collected across every spine at once rather than per spine, so two spines
offering one name is a refusal rather than a chunk quietly spliced into both. A chunk naming a
joint nothing holds is refused by name, for the same reason the alternative design was rejected:
tagging each chunk with its program's name means a tag nobody spelled right lands the chunk in no
program at all, the page boots, and the effect is simply gone.

### A pass that reads the frame it drew last time

The mosh pass in `web/mosh-pass.js` is the third spine and the third bind table, and it is the
only pass in the chain with memory: it draws into one target while reading the one it drew into
last time, then swaps. That is what lets a chunk hold pixels back rather than only transform the
ones in front of it, which is the whole of what a datamosh is. It sits between the trails and the
bloom, feed-side, because a compression artifact happened to the picture on the way here rather
than to the display.

**Memory is what makes a pass unseekable, so the memory has a stated ceiling.** A frame that
depends on every frame before it cannot be reproduced by any length of pre-roll — the failure
`MAX_AGE` in `web/surface-memory.js` exists to prevent one surface over. So a package binding on
this table declares exactly one parameter as its `bounds`, in seconds, and the render loop raises
`moshIFrame` for one frame whenever that much program time has gone by. On that frame the pass
draws exactly what it was handed and reads no history at all.

That is a GOP, and seeking works the way seeking to a keyframe works: `moshFramesBack` walks back
to the nearest frame the pass refreshed on and the seek decodes forward from there. Three kinds of
frame end the walk — the refresh itself, the pass's first live frame (whose history is black), and
the head of the take — and the walk is in frames rather than in seconds because that is what the
loop renders. A walk subtracting `1 / outputFps` off a float lands a whisker under a boundary and
reports a refresh one frame early.

**The memory is bounded twice over and the pre-roll only reads one of the two.** A shipped
datamosh also fades what it holds by a decay each frame, so at 0.88 a frame the trail is down to
0.05% after sixty and the refresh has nothing left to bound. A decay-aware walk would stop sooner
and make every scrub cheaper — the shape `trailsFramesBack` already has — and it is deliberately
not built: it would need a second role marker in the manifest naming which term is the decay, for
a saving that only shows while somebody is dragging the playhead. The refresh is the stated bound
and the pre-roll is measured against it, so the answer is sometimes longer than it strictly needs
to be and never shorter.

**A seek with no pre-roll at all does not isolate this pass**, which cost one green mutation run
before it was noticed. `resetAccumulators` clears the surface memory too, and its state texture
reads differently on its first frame whatever the fade and wake say, so an arm rendered with
nothing before it parts from a playback on a build whose mosh reads no history whatsoever.
`timeline-check` section 7 isolates it with a *short* pre-roll instead — long enough for every
other accumulator to converge, short of the refresh by enough that only the smear's own history
is missing.

**A camera move does not clear it, and that is the opposite of the trails.** Screen-space history
belongs to the pose that produced it, so `renderProgramFrame` clears the afterimage when the
camera moves; dragging stale pixels through a camera move is what this pass is *for*, so its
history survives navigation. `timeline-check` asserts the camera path is identical across its
playback, seek and control arms, which is where a divergence would show.

### Hotload is boot, run a second time

`adoptEffectPackages` rebuilds the shader programs, the parameter registry, the panel and the
uniform cells from a set of packages, and ends by walking every value back through `params.set`.
Boot is its first call. There is no separate install path, which is the point: a code path that
only runs after an install is a code path nobody exercises until it matters.

Parking and unparking are the serialise/restore round trip rather than two loops. An arriving
effect finds its values in the document and applies them; a departing one finds them unrecognised
and parks them, and the badge, the validation and the suppression prune all fall out of code that
already existed. Pages converge by comparing revision lines every few seconds, standing down
while an export, a preset gesture or a track evaluation is running, and asking again after the
last read so a gesture that starts mid-poll defers it rather than being run over.

**A hotload that fails part-way puts the page back.** The door is not a compiler — GLSL that is
syntactically broken while naming only identifiers this build has gets past it, and a shader that
will not link is a log line rather than an exception — so the page warms the swapped programs and
treats a link failure as a throw. Restoring the open document can throw too, reachably: install a
fork that adds a parameter while a document holds that effect and the completeness rule refuses
the subset. Either way the page re-adopts the packages and the programs it was holding and
restores the document it had, synchronously and without the network, because the moment there is
nothing left to fall back to is the wrong moment to need a fetch. The corner where the rollback
itself fails says to reload the page and repaints nothing, since a panel painted over a state no
document describes is a page that looks well and is not.

**The two failures that paragraph names roll back identically and are told apart afterwards,
which is the one asymmetry in it.** A shader that will not link is a fact about a package: it is
on disk, it is what the driver rejected, and the rollback leaves it exactly where it was — so the
next page to open compiles it at boot, where `warmPrograms` runs outside any transaction and takes
the module down with it, publishing no `__kinect` at all and leaving every tool in the suite
reporting that it did not run. A document that could not be carried across is a fact about the
pairing of one clip with one manifest, and the package may be perfectly good. So the throw out of
`warmPrograms` carries a mark and `setAsideUnlinkable` is called on that mark alone: a build that
quarantined on the other one would rename somebody's authored fork out of the way because a single
clip on a single machine could not be opened onto it, and the operator's next move — opening a
document that names the parameter the fork added — would have worked.

**Which package to name is the hard half, because a link failure is a property of the assembled
program.** Both programs are one text spliced out of every installed package and the driver's log
is about a line number in that text, so nothing in it says whose GLSL that was. What the page does
know is which packages *moved*: it is holding the set it was drawing with, whose programs linked,
beside the set it just fetched. So the candidates are the ids that arrived and the ids whose
revision changed — one when one changed, and all of them named in the reason when several did,
since setting a package aside renames it rather than destroys it and it stays on disk to be
repaired. An id in the old set and absent from the new one is not a candidate at all: its text is
not in the program that failed to link. The sequence terminates because the store moves: the page
is blocked on the signature it failed to adopt, quarantining changes what the next listing says,
and the rebuild after it links. A store that set nothing aside leaves the signature where it was,
the block stands, and nothing asks again.

### A document may name an effect this build has not got

The refusal splits three ways on one predicate. A bare name core does not know is a typo, and a
dotted name whose package *is* installed but lacks the suffix is a half-package: both refuse. A
dotted name whose prefix is not installed **parks** — the viewer loads, the installed part renders
pixel-identically, and the values and tracks under that prefix go to a pool nothing evaluates and
nothing destroys. The serialiser merges the pool back without inspecting it, so a load-save round
trip through a build lacking the effect returns every parked key holding exactly the value it
arrived with — nothing renormalised, nothing rebuilt, nothing dropped and nothing added beside it
— and `requires` carries the document's own entries whole so version and revision survive. Presets
exclude the pool by construction: a project merges it back and a preset must not.

**Per key and not per byte, which this page said the other way round for a while.** Two things in
the round trip move bytes without touching a value: the parked keys are appended after the
installed ones, so a document that interleaved them comes back re-ordered, and every number goes
through `JSON.parse`, which reads `1e0` and writes `1`. A load and save on a machine missing an
effect therefore changes the file and moves its revision. That is accepted — what the parking
promises is that the work is intact, not that the file is the one it was — and the distinction is
worth keeping straight, because `tools/library-check.mjs` proves the value property and no arm
anywhere proves the byte one.

**An effect that is here at another version is surfaced and never refused.** `requires` carries
a version and the loader compares it against what is installed, but a version string says nothing
about which direction is compatible, so refusing would make every retune of an effect a wall in
front of every clip on the machine. The clip loads, the installed version draws it, and the bar
carries `document requires glyph 1.0.0, installed is 2.0.0` — a line and no control, because
there is nothing to decide and export is not refused for it. The notice does not survive the next
save, which is the derived field working rather than a loss: the list records what the document
was last built from, and this machine has now built it.

Export refuses by default while anything is parked, naming the ids and versions, because a video
leaves this machine and nothing in it says a layer of the look was absent. Suppressing is the
operator saying this render may go without that effect, per effect and per session, and the
deliverable's sidecar records what was skipped rather than rewriting the clip.

## Program time is the edit coordinate

Source time is a position inside the capture; program time a position inside the output.
They advance together at normal speed and diverge under a ramp, a hold or a reverse, so
every keyframe has to be stamped in one of them. Every track here, including the retime
curve, is in program seconds - which second they are counted from is a separate question,
answered under a clip's look below - and rendering is forward-only: `programTime = k / outputFps`,
evaluate the tracks, `sourceMs = retime(programTime)`, binary-search the index.

- **Export needs no inverse.** Keying in source time would force export to invert the retime
  curve, which requires it to stay monotonic, so a hold or a reverse breaks it outright.
- **The camera keeps its own pace when the footage slows**, which is the creative point: a
  photographer's movement is independent of what they are filming. A ramp leaves the program
  length alone, so a camera key at program 10s stays there. The speed control changes the selected
  clip's output length and rescales that clip's local look and placement keys around the curve's
  rate pivot. Project tracks, camera keys and output cuts keep their authored program seconds.
- **`fade` and `wake` stay in source time**, because they drive surface memory, which
  advances per source frame. Dividing by the local retime slope would divide by zero at a
  hold, snapping every trail off exactly where a freeze should hold it.
- **`outputFps` is the project's, not the deliverable's**, and the line above is why: it is
  the denominator of the edit's own coordinate, so two deliverables at two rates would be
  two different edits rather than one edit written out twice. `trails` makes it visible —
  it is the one look term whose length is counted in output frames rather than in seconds,
  because `AfterimagePass` multiplies the picture it holds once per rendered frame with
  nothing in the expression about how long a frame lasted. At damp 0.9 a trail is down to
  12% after twenty frames, which is 0.83s at 24fps and 0.33s at 60.

The shape the stage is letterboxed to is document state for the same reason and the pixel
count is not. A project carries `aspect` as a reduced integer pair — `[16, 9]`, `[256, 135]`
— because the camera was keyed against a frame, so reopening a 65:24 edit at 16:9 would be a
different shot with the same keys. A deliverable carries the resolution, because every
screen-space term is expressed against 1080p and bloom's chain is frozen at 600 whatever the
buffer is, so two sizes of one shape reopen identically. Both fields are additive and neither
bumps `PROJECT_VERSION`, which presets share: absent `aspect` means the shape of the legacy
`outputSize` beside it, and absent `outputFps` means 30. Deliverables have their own version
and it is 2 — a version 1 document names a rate this build ignores, so it would parse
perfectly and render the wrong file, which is what a version gate is for.

Frame index was rejected as a coordinate because capture frames are not evenly spaced in
time, so constant motion through index space is visibly variable motion through real time.

## Clips, and what a cut costs

Audio is a separate program-time source. `web/audio-source.js` derives a 100 Hz control curve
from normalized PCM, then answers arbitrary program positions without transport history.
Stereo energy is measured per channel so opposite phases do not cancel. The same lookup feeds
seeks, playback, and export. `web/audio-session.js` owns decoding and audible playback; it
aligns the source to the transport and stops it when the transport pauses or waits for footage.
The source lookup is also the boundary for future recorded MIDI or live-input curves; this
build only imports audio files.

The renderer applies the additive result after keyed base values, directly to the effect's
runtime parameter. The document retains the base, source hash, conditioning, and mapping.
`server/audio.js` imports bounded uploads through FFmpeg with only the pipe protocol allowed,
stores normalized WAV files by content hash, and verifies those bytes before reads. The export
server copies verified audio into its private render directory, trims by program time, and
adds silence outside the audio clip. The export record includes the program start and source
identity. Modulation EQ does not alter the soundtrack.

A clip owns a source, a cloud, a retime curve, a `start` and a `length`. It covers
`[start, start + length)` - half-open, so two clips abutting at a cut do not both draw on the
frame the cut lands on, with the one exception that the instant an edit ends on belongs to
whatever ended there rather than to nothing. `length` is the document's own field and it is read
back as the answer: a trim is where the edit stops using the take, which is a different fact from
how much take there is rather than a second spelling of it, and null means "everything the curve
affords". A gap between clips renders an empty composite.

**Each clip draws through `Group(transform) -> Group(level) -> Points`.** The outer group is where
the clip sits in the room; the inner one carries the levelling quaternion, which is a clip-scope
value now, so the readers that ask which way is up are asking about the selected clip. The outer
group is written by a registry parameter like any other: `transform` is a `placement`, which is a
pose minus the field of view - validated the same way, slerped by the same `poseAt` - and it is
composition rather than look, so the panel draws no row for it and no preset carries one.
Position and rotation only. A scale would fight two things that are not in the geometry:
`pointSize` is screen-space and would not scale with it, and the fog is world-space. An idle
clip sets `transform.visible = false` and costs no draw at all. Draw order is written onto the
points explicitly - depth-writing clips first, additive ones after, ties broken on the clip's id -
because "any order" is true of the picture and false of the bytes, and an export that reordered
two clips between runs would write different files from one document.

**The pipeline splits per take and per clip, which is the part editors get wrong.** The capture
bytes, the frame index and the fetch cache belong to the take: `IndexedTake` holds them and every
clip cut on that take shares one, so two clips of it fetch and JPEG-decode a frame once between
them. Everything from `createImageBitmap` on is the clip's: `IndexedPairSource` is a walk of its
own over that take, and the bound bitmap, the four texture cells, the surface memory and the
uniform table are per cloud. Two clips of one take at different local times therefore hold
different frames in front of different shaders. Two consequences follow and both had to be fixed
rather than reasoned about: a trim must skip the bitmaps *every* clip has bound, not the ones in
front of the selected cloud, and it must keep the frames every outstanding fetch has claimed, not
just the run it was called after.

**A clip is reset, then warmed, then shown.** Its ping-pong pair holds whatever it last drew, so
a clip appearing mid-playback would show no fade and no wake on the frame after the cut while the
same instant reached by seeking looks right. For its own surface span before its in-point the clip
binds its textures and steps its memory with `visible = false`, and the prefetch looks across the
clip boundary so those frames are resident when the warm starts. The window is bounded by what
the clip's head affords: the curve extrapolates outside its domain, so the walk stops where source
time would run before the take began - and it stops where source time stops *moving*, because a
clip entering mid-hold reaches the frame already bound however far back it is walked. A clip whose
footage starts at source 0 and one entering mid-hold both enter deterministically cold, and so
does a seek to that instant, which is why the invariant holds rather than being violated.

Pre-roll splits along the same seam. The surface half is per clip, because surface memory is per
cloud and one clip's curve can need three times another's to cover the same span of persistence,
so the project's is the longest of them. The trails half is one screen-space buffer over the
composite and is asked once. There is one stall policy and not two: a render waits for every clip
it touches, drawn or warming, and playback's catch-up budget bounds how far behind the playhead
may fall rather than what a rendered frame may contain. With more than one clip the difference
between those two policies is which clips are in the frame, which is a different image rather than
a later one.

`CLIP_CEILING` is 8 and it is a document gate rather than a cost bound: a clip costs a cloud
whether it is on screen or not, and what a frame costs is set by how many are live at once.
`docs/performance.md` carries what four overlapping clips measure at.

**A take's cache is sized by the clips asking for it.** A seek plans per clip and the cache is per
take, so a constant one capped the pre-roll of every clip after the first: four clips of one take
rendered 42 of the 60 frames they had computed. The transport publishes what each take is being
asked for when it plans, and the take's capacity is that plus a fetch's worth of slack, floored at
the 192 frames a single clip always had and bounded by a ceiling derived from a memory budget
rather than written as a frame count - because what a resident frame costs is the thing that
varies, and it is measured rather than estimated. The demand is per clip and not per project:
`spansOver` asks each clip where it is in its take, and whether a clip is drawn, warming or idle
at a position is worked out from *that clip's own* fade and wake. Two clips placed at the same
instant, one with a long persistence and one with a short one, are a warming clip and an idle one,
and only the first is counted. The floor is what keeps a one-clip project
exactly as expensive as it was. The ceiling and the span a plan may ask for are one number in two
forms and cannot be moved apart: a cache smaller than the span a fetch may request evicts what
that fetch has just put in it.

**A head trim is written into the curve, because that is where an in-point lives.** A clip has no
source-offset field: with no keys its curve reads `programSec * rate` and states an in-point of
zero, and with one key at the origin it reads `value + programSec * rate`. So dragging a clip's
head writes that single key and moves `start` and the trim together, which holds the out-point and
the footage under the body still. Three places ask whether a curve is still a rate and two of them
already answered "fewer than two keys" — `sourceSecAt` and `slopeAt`; the speed slider's disable
was the third and said "any keys at all", so it went quiet on a curve it could still drive. The
three agree now. A curve of more than one key states far more than an in-point and shifting its
domain is a different edit, so the head edge refuses it with the reason rather than being an edge
that silently works on some clips and not others.

**Which clip is selected is session state and never in the document**, beside `suppressedEffects`
rather than in the project. It decides where a look write lands, which curve the retime lane
draws, and which clip the take's marks are drawn against - but which clip somebody is looking at
is not part of the edit, and a document recording it would make two people's saves of the same
work differ over nothing. A reopened project selects nothing.

**Adding and removing a clip is an ordinary undo step**, because clips live in the body
`history.snapshot()` stringifies. An add copies the selected clip's look, or the first clip's
look when the stack has no selection, so the project-level action never depends on session
selection. Removing one is the one case that needed more than a
`history.commit()`: `restoreProject` is synchronous and refuses a document whose clip names
footage this page is not already holding, and the undo of a delete hands it a clip array with a
slot the page no longer has. Footage that is *open* is not a fetch, so that slot is re-pointed
from the take rather than refused - and a take a clip stops using loses its decoded frames and
keeps its index, which is what makes it still open to be re-pointed from.

**The stack does not outlive the page, and that is what makes the paragraph above true rather
than usually true.** The argument rests on a precondition: every take any entry in the stack
names is currently open. A session holds that by construction, because every entry was a
snapshot of a document the page was holding at the time, and `openTakes` only ever grows. A
saved stack discards it - a load opens the footage the *body* names while the stack reaches
below the body, so an entry can name a take the reloaded page never fetched. That shipped:
add a clip on a second take, delete it, save, reload, and undo walks down into a snapshot the
synchronous door then refuses, permanently, because the poison is in the file and every fresh
load re-arms it. So undo is session state and the document is the file's: nothing writes a
stack out and nothing reads one in, a load always starts a fresh one, and the door's refusal
becomes an invariant nothing should ever be able to trip rather than a case a document can
reach. A file written before this still parses - `checkProject` reads the fields it names and
ignores the rest - and its stack is simply not read.

**The selection is re-found by the id it named, not by the object holding it.** `fitClipCount`
only grows and shrinks at the tail, so restoring a document that had a middle clip appends an
object and re-labels every clip past the deletion point; an identity test survives that rewrite,
and the selection silently becomes whichever clip inherited the slot while the highlight never
moves.

**The parked pool is per clip too**, because a value belongs to the block it arrived in and two
clips are allowed to park different values for one missing effect. `requires` stays project-level:
it names which effects a document was authored against, which is a fact about the document.

**A clip's look is its own.** Its clip-scope values, its placement, the tracks that move them and
the pool of values it arrived carrying that this build cannot read all live on the clip; the post
chain's terms, the view state and the camera live on the project, one of each however many clips
draw into it. The scope on a parameter is what says which block it is written to and read back
from, and it is not a property of the look tag: a look value carries one always, a composition
value carries one where it is stored per clip, and view state carries none because it is stored
nowhere. A preset is applied through the same door, so its cloud values land on the selected clip
and its post values land on the project - which is to say applying a preset to one clip moves the
grade every other clip in the edit is seen through, and the editor says so rather than leaving it
to be discovered. Framing stays outside that door: levelling, clip planes and the crop box belong
to the shot and no preset, including `none`, can write them. There is no union: `checkProject`
reads each clip's block into that clip, and two clips
of one document are allowed to disagree about every value in them.

**Which clip is selected is decided at the door the editor was opened through.** Opening a take
selects its clip - a take is one clip of footage somebody has just chosen, so there is nothing to
choose between, and a greyed panel there is a regression rather than a design. Loading a project
selects nothing, because a document does not record which clip was being worked on and two
people's saves of one edit would otherwise differ over it. `applyProject` chooses neither: it
drops a selection whose clip the document no longer has, because a strip left holding a clip that
is not in the array is one `deleteSelectedClip` would splice by an index of -1.

**Everything inside a clip is on the clip's own clock.** A clip-scope track - its placement, its
grade, its crop, every parameter the panel's clip half holds - is read and written at program time
less the clip's in-point, and the project's own tracks, which are the post chain and the camera,
are read at program time. `trackEpoch` is the one place that answers, and what it asks is the
parameter's scope. The reason is what dragging a clip means: a clip is a thing with a look and a
place, both were authored against the clip and both have to arrive with it, where a key at an
absolute program second would stay where the clip used to be. The boundary being scope rather than
a list of parameters is what stops this drifting - a term added to the clip block next year is on
the clip's clock by existing, and nobody has to remember it. The stored `t` on a clip's key is
clip-local too, so a saved edit survives being re-cut, and `keyframe-check` section 6g holds the
rule at both ends: a keyed grade read back after a real drag of the clip box, and a key planted
from the panel over a clip that does not start at zero.

**What a placement does not reach is `room`.** `vec3 room = mat3(modelMatrix) * p0` drops the
fourth column, so the lattice's cell grid, the glyph field's character identity and the rain's
phase are computed as though every clip were at the origin - a placed clip carries its character
field with it rather than moving through the room's. The transpose identity those shaders rest on
survives, because it is the 3x3 that matters and a translation is not in it.

Where a look write lands is an explicit indirection - the clip under evaluation, else the selected
clip - and not a binding repointed for the walk. The selection is the operator's: the panel, the
lanes and the retime curve are all views of it, so a render that moved it would be mutating what
somebody is looking at in order to draw a frame. `withClip` is the one door that changes the
answer, and it moves two things together because neither is enough on its own: the tables decide
where the value is stored, and the render core's selection decides which uniform table, material
and levelling group the registry's `apply` reaches.

## Projects, and which one is open

**A project saves itself and there is no save action.** Every project autosaves the way the one
working document does today, so the file on disk and the edit on the screen never disagree, and
there is no dirty flag that has to be kept right on every path that mutates the edit. What that
costs is the ability to throw an experiment away by declining to save it, and duplicating a
project is the answer to that rather than a second save model standing beside the first.

**There is one kind of document and it carries a name from the moment it exists.** The hidden
`__working__` file is gone and the recovery chip that offered it back went with it: the control on
the projects page makes a project called `Untitled 1`, every edit is in the list from its first
frame, and a crash loses nothing autosave had not already written, so there is nothing left to
offer. Nothing prompts for a name, because a name is a label to change later rather than a
decision to demand before anybody has seen a frame. The save action goes too - `Save project` and
its shortcut named the moment an unnamed document became a named one, and there is no such moment
any more.

**Projects and takes get a page each, and the projects page is the one you land on.** The takes
grid is a store of footage this machine holds or can pull down off the node, and it is a
different question from which edit you are continuing, so the two stopped sharing a page: the
landing page lists projects only and carries the control that makes a new one, and the takes grid
keeps its own page and its whole job - the two-machine manifest, download, reclaim, rename,
reveal. Neither page grew a section belonging to the other, because a page that answers one
question is the one that can be made good.

**The library's `Open` says `New project from this take` instead, because `Open` did not say what
it did.** A control that mints a document is a different act from one that shows you footage, and
one word covering both is how a list fills with projects somebody only meant to look at. Looking
is the viewer the library already has - full screen, frame stepping, mark ticks, previous and next
take - so nothing new was needed to separate them, and the act that creates something now says
`project` on its face. The project it makes is named after the take and you land in it, because a
control that says it makes a project and then leaves you looking at the list has not finished.

**`/edit?take=` survives as the render worker's bootstrap and creates nothing.** The human route
into the editor is a project, so the take door has one consumer left: `tools/render-worker.mjs`
brings the page up on the first clip's take and then pushes the job's document in by value. A page
opened that way holds no document, which means it has no file to autosave into and writes nothing
at all - the same rule that used to be carried by `__working__` existing, now carried by there
being nothing to write to.

**The takes page is the media library, and the word `gallery` is gone.** The store it draws was already
called that everywhere it is implemented - `server/library.js`, the `/library` routes, the client
that renders it and the tool that proves it - and `gallery` named nothing but the URL those pages
were served at, so the page is at `/library` and reads Media library. Splitting the pages was the moment
to spend that rename and not a moment later, because a second page arriving under the old name
would have doubled what the next reader has to reconcile.

**The menu's tiles are RECORD, PROJECTS and MEDIA LIBRARY, and the EDITOR tile is gone.** Nobody goes to
the editor, they go to a project, so picking up yesterday's work is the projects page's own job
rather than a fourth door standing beside it. What leaves with the tile is the resume record it
read - a `localStorage` entry naming a take hash, matched back against the library listing to
rebuild a URL, and a sentence for the machine that has never opened anything. A project is a name
the server already lists, so nothing has to be remembered on the side to find it again.

**A project shows a picture, and dragging it walks the cut.** The listing hands the whole document
body over, so the name, the clip count, the shape and the rate cost nothing to show; frames are
the only thing fetched, and they are drawn by the same depth splat the library's tiles use, which
is what makes the two pages read as one program. What the finger moves through is program time and
not one take's frames: the clip covering that second is found by its `start` and `length`, its
retime curve maps the second into source time, and the skim changes capture at a cut - so the
bar's length is the edit's length and a cut in the edit is a cut in the skim. The look is the part
that cannot come along, because nothing on this page holds the grade, the effects or the camera.
A project skims as raw geometry and reads as a proxy rather than as a small render.

**A project whose footage is not on this machine says so on its row, and the control goes to the
library.** The loader refuses a document naming a take no local capture hashes, and reclaiming one
take from the library is enough to put every project cut on it into that state, so the page
listing every project is the page that has to say which are dark and which take is missing. What
it does not do is fetch. The download, its progress and the two-machine state live on the library
page already and a second copy of them here would be the duplicated path this design keeps
refusing, so the row names the takes it wants and sends you to the page that can get them.

**The clip picker is the library's tile with the lifecycle buttons taken off.** Adding a clip used
to offer a list of names, and a name is the one thing about a take that says nothing about what is
on it, so the picker draws the same poster, the same scrub bar, the same mark ticks and the same
warning badges the library page draws. The only difference is that nothing in here deletes,
renames, reveals, reclaims or downloads. That is the media picker inside a project, and it arrives
without the library page having to move into the editor.

**One module draws a take, and three surfaces call it.** `drawFrame`, `createSkim` and
`paintMarks` were local to `web/library.js` with no exports, which is the whole reason the picker
showed names: there was no way to reach them. They move behind a seam of their own - a take, a
canvas and an index in, a drawn frame out, and the capture free to change between draws so a skim
can cross a cut - and the library page, the clip picker and the projects page's row are its three
callers. `web/record-poll.js` is the precedent for the move and `module-check` is what holds the
import graph to it.

**The picker does not know which project it was opened from.** Every local take, one order, newest
first, and no mark or reordering for the footage this edit already uses - so a tile is in the same
place whichever project asked for it and nothing moves under a cursor on its way to a click. What
that costs is a scroll past a long shoot to reach a take already on the timeline, and it is the
right trade while the dialog is a view of what footage exists rather than a second record of what
this project has claimed.

**The list is ordered by when each project was last written, and nothing is stored to know it.**
The listing already carries a `savedAt` off the file's mtime, and every edit autosaves, so the
project at the top is the one last worked on without a second timestamp existing anywhere. A
project opened and only watched does not move, which is the honest reading rather than a gap:
looking at an edit is not working on it, and the alternative is either a field in the document
that makes opening a project a change to it or the per-machine side record the EDITOR tile just
took away with it.

**`Save project` became `Rename project`, and `Duplicate project` sits beside it.** The item and
its shortcut named the moment an unnamed document became a named one, and there is no such moment
left - but the two acts that survive it are exactly the ones wanted from inside a cut: giving a
name to the `Untitled 4` somebody has been working on for an hour, and forking it to try
something. Rename opens a modal because a name is typed, and duplicate is what stands in for the
save nobody makes.

**Duplicating leaves you in the copy.** Forking is how somebody declines to keep something once
there is no save to withhold, so the copy is where the next edit is going and landing anywhere
else costs a second move to get there. The original is untouched and one row down the projects
page. Deleting is not on this menu at all, because autosave would write the file back the moment
anything was touched, so it belongs to the page listing projects you are not inside. `Cmd+O` goes
to that page.

**A name a person types and a name the recorder mints stop sharing one expression.** `VALID_ID`
guards every string this program joins to a path and it allows no space, so `Untitled 1` could not
be written and neither could `Beach shoot` - which was invisible while the only document anybody
named was named through a prompt they could retry. Take ids keep it, because nothing types one.
Document names get their own rule that allows a space and still rules out what the shared one
ruled out: a leading dot, `..`, a slash either way round, and control characters. Two expressions
is the cost and the second one guards the same path join as the first, so it is written with the
same suspicion.

**A clip whose take is not here draws nothing, and the skim keeps moving.** A row scrubs across
its clips, so a project missing one take is three clips that resolve and one that does not: the
span the missing clip covers goes empty, and where that clip carries a length of its own its
width says how much of the edit the hole costs, beside the row that already names the take. A
clip nobody trimmed carries no length - `null` there means it runs for everything its curve
affords, which resolves through the take's own duration - so on the machine that has not got the
take there is no width to draw, and the row names it rather than measuring it. It
also leaves one behaviour rather than two - a clip either resolves to a frame or it does not, and
nothing has to ask whether a project is dark before deciding to answer a drag.

**A write carries the revision it was made against, and a stale one is refused.** The store
already hands a `rev` back on every read and every write, and a projects page makes opening one
edit in two tabs ordinary, so autosave sends the rev it last saw and the server refuses a body
whose rev has moved. It is the rule take rename already runs under - two writes aimed at one name
are answered by the kernel rather than by a stale reading, and the loser keeps its work - and it
is what stops rename forking a project into two diverging files, since the tab that renamed moved
the file and the tab that did not is now writing against a revision that is not there. The cost is
that autosave gains a failure it has to word, and `auto-save failed` is not the wording: a refused
write means somebody else has this project open and this tab's last change did not land.

## Surface memory

A ray landing on a different surface between frames is a death and a birth, and teleporting
the point was the loudest artifact in the image: 3.14% of pixels flip valid/zero every frame
pair, 44x more than the snap threshold ever touches. A ping-pong float target remembers
where each ray used to be and how long ago it swapped.

- **`fade`** cross-fades the transition, the new point ramping in as the old one thins out.
  120ms by default, and the correctness half.
- **`wake`** lets a hard transition linger past the fade, shedding a trail from moving
  silhouettes. 0 by default, 550ms under Blackwall.

Wake length keys off the local depth spread rather than the raw transition, which keeps a
static scene from shimmering. Measured live, of 2.56% of pixels swapping per 50ms, 2.36%
classify soft (the depth solve's confidence gate chattering on a flat wall) against 0.20%
hard.

Both are in milliseconds, so a better frame rate does not silently shorten the look. At zero
the ghost geometry leaves the draw range and the original 217088-point draw is restored
exactly; `__kinect.stateStats()` reads the memory back.

## Frame interpolation

The sensor delivers 30fps on a healthy USB topology while the display runs at 120Hz, so the
vertex shader blends between the last two depth frames rather than holding each one until
the next arrives.

- **Blend time comes from measured arrival spacing** kept as an EMA, not an assumed 30fps,
  because guessing the interval wrong on a degraded link stutters worse than not blending at
  all. The blend clamps at 1.0 so a late frame holds on the newest data rather than
  extrapolating past it.
- **Discontinuities snap instead of lerping.** A hand crossing in front of a wall jumps
  metres between frames, and interpolating that draws a smear through empty space for the
  whole interval. Above `snap mm` the point jumps to the new depth.

Both are verified against synthetic depth planes rendered offscreen: a 1200 mm jump lands
exactly on the new depth, a 100 mm drift interpolates to the midpoint. Worth re-checking
against real motion, since the sample this was written against is nearly static (0.06% of
pixels exceed the snap threshold between frames).

## Wire format

One framing for the live stream, the recording and the replay, so a capture file
is byte-identical to what the grabber emits:

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

**`format` is the generation of the capture format, and a take carrying no `format` key is
generation zero.** Nothing migrates old captures, because rewriting a capture to add a key
is the one operation this design will not perform on an artifact that cannot be shot again.
A take declaring nothing opens, a take declaring this build's generation opens, and anything
else is refused rather than unprojected on assumptions that may not be its own.
`web/format.js` owns the number, `native/grabber.cpp` carries the only other spelling, and
`tools/syntax-check.mjs` requires the two equal and this key list to be exactly what the
grabber emits.

**Four of the other keys are load-bearing.** `startedAt` is the only durable capture date a
take has, since frame stamps are `steady_clock` and monotonic since boot; a writer that omits
it lands every take dated by mtime, so the library's ordering silently becomes "when it was
last copied", and it degrades quietly because `describeTake` reports `dateSource: 'mtime'`
rather than an error. `minDepth` and `maxDepth` say how much of the world the file was
allowed to contain, and the editor paints its preview range from them. `lowLight` says
whether the colour camera was run long-exposure.

**`startedAt` means one thing on the wire and a narrower thing in a file, and the difference
is the whole reason the field works.** The grabber says hello once per process, so the value
it sends is when *the grabber* came up. Written straight through, that put a byte-identical
date on every take of a session and none of them was when its own take was shot — two takes
nine minutes apart came back indistinguishable, on the one field the library sorts and prints.
So `Recorder.open` replaces it: the hello it writes into a take carries when *that take*
began, which is the clock it already has to stamp the take with anyway. On the wire the key
is the session's; in a `.knct` it is the take's, and a take is the only thing a file is about.

The key is reused rather than joined by a second one, and that is a deliberate trade. One
reader consumes it — `describeTake`, for `capturedAt` — so there is no caller that could want
the session start out of a file and get the take start instead. A new key would have been the
tidier spelling and it would have had to be emitted by `native/grabber.cpp` to satisfy
`syntax-check`'s hello-key comparison, which would mean the C++ emitting a field only the Node
recorder can fill in. Takes shot before this carry the session stamp and nothing in the file
distinguishes them from takes shot after, so their dates stay as they were: wrong in the same
way, and not detectable without a marker that was deliberately not added.

**Type 3 is live-only, so "byte-identical" means identical to the type 1 and 2 subsequence.**
The colour message is dropped at the recorder, because a third message type in the file would
move every take's content hash, which is the key the library joins two machines on.
`vcam-check --mutate hd-reaches-recorder` keeps that true.

Measured over a real capture: 434,176 bytes of depth plus a 49-59KB JPEG, 486KB per frame. At
30fps that is 14.6MB/s, or 117Mbit/s per connected browser: fine over ethernet, right at the
practical ceiling of Wi-Fi.

The grabber writes frames to stdout and every log line to stderr, because one stray log line
on stdout would desync the stream permanently. The browser needs `fx/fy/cx/cy` from the hello
to unproject, and hardcoded intrinsics skew the cloud in a way that is hard to spot and hard
to attribute.

**Every frame in this format is horizontally mirrored, and the readers undo it rather than the
writer.** libfreenect2 delivers depth, IR and colour flipped left-for-right on purpose, to
match the Microsoft SDK's selfie-view convention, and the grabber `memcpy`s the buffer through
untouched, so the sensor's frame reaches the file exactly as the driver produced it. The
correction is one sign in the unprojection — `X = -(col + 0.5 - cx) / fx * z`, with `cx` used
exactly as the hello reports it, because the grid width cancels out of the algebra. That is one
sign away from `Registration::getPointXYZ`, which pairs the same mirrored image with an x that
grows right and therefore describes a reflection of the room; `server/protocol.js` carries the
derivation and the warning not to copy upstream back in.

**Undoing it in the readers rather than in the grabber is what keeps the archive
single-valued.** Flipping columns before the wire would leave every take shot before the change
mirrored and every take after it not, with nothing in the file to tell them apart — the split
that `format` exists to prevent, arriving through a different door. Correcting on the way out
means one geometry for the whole archive, old takes included. The cost is that the sign is
stated by five readers (the vertex shader, the top-down, the library poster, and the oracles in
`export-check` and `monitor-check`) plus this specification, and `level-check` section 8 is what
holds them to one answer.
