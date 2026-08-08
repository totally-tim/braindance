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
one interval stale. The grabber logs both counts (`600 frames (293 colour)`), because a
lagging colour rate is the one thing that explains a stale-looking image.

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

**Renaming moves a label and never a reference.** A project records its take as
`{id, hash}` and the loader compares only the hash, so a rename carries the capture, its
marks and its index to a new name and every project still opens. Two renames aimed at one
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

## Program time is the edit coordinate

Source time is a position inside the capture; program time a position inside the output.
They advance together at normal speed and diverge under a ramp, a hold or a reverse, so
every keyframe has to be stamped in one of them. Every track here, including the retime
curve, is in program time, and rendering is forward-only: `programTime = k / outputFps`,
evaluate the tracks, `sourceMs = retime(programTime)`, binary-search the index.

- **Export needs no inverse.** Keying in source time would force export to invert the retime
  curve, which requires it to stay monotonic, so a hold or a reverse breaks it outright.
- **The camera keeps its own pace when the footage slows**, which is the creative point: a
  photographer's movement is independent of what they are filming. This is about the retime
  *curve*, where a ramp leaves the program length alone so a camera key at program 10s stays
  there. The speed control is different: it changes the clip's output length, so every
  program time is reparameterised together, camera track included.
- **`fade` and `wake` stay in source time**, because they drive surface memory, which
  advances per source frame. Dividing by the local retime slope would divide by zero at a
  hold, snapping every trail off exactly where a freeze should hold it.

Frame index was rejected as a coordinate because capture frames are not evenly spaced in
time, so constant motion through index space is visibly variable motion through real time.

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
it lands every take dated by mtime, so the gallery's ordering silently becomes "when it was
last copied", and it degrades quietly because `describeTake` reports `dateSource: 'mtime'`
rather than an error. `minDepth` and `maxDepth` say how much of the world the file was
allowed to contain, and the editor paints its preview range from them. `lowLight` says
whether the colour camera was run long-exposure.

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
stated by five readers (the vertex shader, the top-down, the gallery poster, and the oracles in
`export-check` and `monitor-check`) plus this specification, and `level-check` section 8 is what
holds them to one answer.
