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
node server/index.js --effects ~/fx     # where an installed effect package lands
node server/index.js --builtin-effects ./effects-builtin  # what the build ships with
```

**The two effect roots are the fork mechanism, so pointing one of them somewhere else
moves what shadows what.** `--builtin-effects` is the shipped set and nothing in this
program writes into it; `--effects` is the writable root an install lands in, and an id
present in both resolves from there. Both default to directories beside the checkout, and
the flags exist because a proof tool needs a search path it controls rather than the one
the developer happens to have installed packages into. A server whose builtin root is
missing refuses to boot rather than answering an empty list, since a broken install must
not read as nothing-installed.

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

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel. **Shift is the free
camera's modifier.** Hold it and `W` `A` `S` `D` fly the camera, `Q` and `E` take it down and up,
a left-drag turns the camera in place, and the wheel changes the lens. Without shift the six keys
do nothing at all. `W` follows the view direction. `Q`/`E` follow the current navigation vertical:
the levelled room in the normal view and the sensor's vertical in Sensor view. Flying carries the
orbit pivot with the camera, so a drag afterwards still turns about the same subject rather than
about where you set off from.

**Space always toggles playback in the editor.** A focused text field keeps the other keys. Gaining text focus also stops any flight keys
already held. Sliders, dropdowns and other non-text inputs
keep the arrows, enter, home, end and the page keys, so a focused slider still
nudges with the arrows while `Shift-W` still flies and `cmd-z` still undoes. Editor shortcuts take
priority over dropdown letter type-ahead.

**Shift-drag turns the view the way you drag it**, which is the opposite of an orbit: drag right
and the view turns right, so the scene sweeps left. The camera does not move, and the orbit pivot
rides a sphere around it at the distance it already had - so letting go of shift orbits whatever
you are now looking at. A drag the height of the stage turns the view by exactly one field of
view. A longer lens therefore turns through a smaller angle for the same drag. The view stops just
short of straight up and straight down rather than tipping over. Releasing or cancelling the
pointer, losing focus or pointer capture, hiding the page, and changing cameras end the look drag.

**The orbit turns about whatever you pressed on.** A left press reads the depth under the
pointer and moves the pivot along the view axis to that range, so orbiting a subject four metres
out turns around it rather than swinging it across the frame. The pivot stays on the view axis,
which is why the press changes nothing to look at - what changes is the turning radius. A press
on the background, on a hole in the depth returns, or on geometry outside the crop box leaves
the pivot where it was, and **Reset** still goes to the home pose rather than to the last pivot
you picked. The pick reads the depth frame and not the drawn picture, so with the displacement
effects or the datamosh up it lands on the surface that is really under the pointer rather than
on the smear the eye is aimed at.

The ruler shows a *window* of the clip, because a fifteen-minute take across one screen puts
a keyframe against gradations forty times coarser than the thing being placed. Scroll to
zoom about the pointer, `+`/`-` about the playhead, `,`/`.` to pan, `F` to fit the clip. The
overview underneath is always the whole clip: drag its box to pan, click to go there.

Press `I` and `O` to set the trim at the playhead. Choose **Output > Whole clip**, or press
Option-X, to restore `{ in: 0, out: null }`. The null end means the range continues to the end
if the program later grows; writing the current duration would freeze it there instead.

**Loop**, at the right of the transport row, plays that trimmed range round instead of stopping
at its end: reaching the out-point seeks back to the in-point and playback carries on. It is off
whenever the editor opens, because the transport is built fresh each time and a loop you set on
one take is not a fact about the next one.

**Clips are the rows at the head of the lane stack**, one box each from where a clip starts to
where it ends, above the curves that animate them. The full-width `+` below the last clip opens
the media library's takes even when no row is selected. The first one you choose lands at the
playhead on a row of its own. With no selection, it copies the first clip's look; otherwise it
copies the selected clip's. `delete clip` removes the selected one, and so does `Delete`. There is
a button as well as a key because the Pi's touchscreen has neither a Delete key nor a drag affordance to
discover. Click a box to select that clip, drag it along the strip to move it, and drag either
edge to trim it. The edit refuses to delete its last clip, because a project carries at least
one.

**The two edges do different things.** The right edge moves where the edit stops using the take,
which is the clip's own `length`. The left edge is a head trim: the clip starts later in the take,
its out-point stays where it is, and the footage under what is left does not move — the same
project second stands on the same source frame afterwards. That in-point is written as the clip's
retime curve, one key at the origin, because a clip states where it starts in the take through its
curve rather than through a field of its own; trimming back to the head of the take removes the
key again. A curve of one key is still a rate, so the speed slider goes on working through a head
trim and only goes quiet once a clip carries a curve that says more than an in-point. **On such a
clip the head edge refuses and says so** — moving a keyed curve's domain is a different edit and
this build does not do it from the edge.

**Which clip is selected is the session's and not the document's.** It decides what the panel
writes to, which curve the retime lane draws, and which clip the ruler's marks are drawn against
— and it is deliberately not saved, because which clip you are looking at is not part of the edit
and a document recording it would make two people's saves of the same work differ. Opening a take
selects its clip, because a take builds a project of one clip of footage you have just chosen and
there is nothing there to choose between; loading a project selects nothing, because a document
does not record which clip was being worked on and picking one would be a guess. Pressing on the
empty part of the lane stack takes the selection off every clip.

**With no clip selected the panel keeps its clip half on screen and greys it out.** That is where
a loaded project of several clips lands you, which is the case worth showing the split in. The rows
below `points`, `framing`, `colour` and the rest write one clip's cloud; `post`, `motion`'s
trails and the rest of the grade write the project. Hiding the clip half would make the split
something you have to remember, so it is dimmed and inert instead, and selecting any clip brings
it back showing that clip's values. Selecting a different clip repaints every one of them.

**A clip's own keyed parameters nest under its row and fold with it.** The chevron in the rail
appears once a clip has something keyed; at four clips with a keyed look each a flat stack is one
pile of lanes belonging to nobody. The project's own curves — the camera, and the post chain
every clip is seen through — stay at the foot of the stack, outside every clip.

**`move` and `rotate` put handles on the selected clip in the viewport**, and `G` cycles the two.
A clip carries a position and a rotation in the room and nothing else — no scale, because
`pointSize` is measured in screen pixels and would not scale with the geometry, and the fog is
world-space. While the handles have the pointer the orbit stands down and comes back on release.
The handles draw over the finished picture, so effects change what is behind them and never the
handles themselves. An export detaches their hit target as well as hiding them, then restores it
afterwards, so dragging where an invisible handle was cannot move the clip under a running export.

**`key` beside them keyframes that placement at the playhead**, and presses again to take the key
away. It is there because a placement is edited in the world and so has no panel row and no
keyframe control beside one, and without it the first key on a placement track could not be
planted at all. It reads the three states a panel row's diamond reads: filled where a key is under
the playhead, outlined where the track carries keys elsewhere, plain where there are none. Once a
track has keys a handle drag writes one at the playhead, the same as moving a slider does. Those
keys are measured from the clip's own in-point rather than from the head of the edit, so dragging
the clip along the strip carries the move it was given with it.

**Marks stay keyed by the take and are drawn against the selected clip.** A mark is a fact about
footage, so two clips of one take share them; where a mark ticks on the ruler is that source
second put through the selected clip's curve *and* its placement, which is why the same mark sits
somewhere else when you select the other clip of the same take.

**mark** plants one at the playhead and presses again to take that one away, and `M` does the
same from the keyboard. "Already at the playhead" means within half an output frame either side,
so a press never has two marks to choose between.

**The `lens` row on the *Camera* tab says what the camera's `fov` says, in the millimetres a
lens is sold under.** It is a 35mm equivalent against the full-frame gate — 36x24mm, so a
43.27mm diagonal — and the shape it measures against is the *project's* aspect rather than the
window's, which is why resizing the browser or pulling `render %` leaves the number where it
was. The camera opens on a 22.7mm lens at 16:9, which is the 50-degree vertical field both
cameras boot at, and **sensor view** lands near 18mm because that is what the Kinect's own
intrinsics work out to across its 424 rows. Moving the row writes the camera you are composing
through, which is the one **add key** reads, so a lens reaches the shot when you key it and not
before. Under **set viewport to camera** the row reads the shot instead and goes inert, for the
reason the orbit does the same there: the program camera's lens is what its keys say, so it
follows the playhead through a keyed move rather than taking a new value. The row offers 8mm to
300mm and says which way it ran out past either end — the angle
itself is never clamped, because the sensor's intrinsics have to be free to imply anything.
Shift and the wheel over the stage move the same lens, and that gesture is bounded by those two
numbers rather than only measured against them: a wheel has no value to type, so it stops where
the band does.
`verticalFovForFocalLength` and `focalLengthForVerticalFov` in
[`web/lens.js`](../web/lens.js) are the conversion, and it is the same arithmetic either way
round.

**Easing a move.** Select a key and the `key options` row shapes the segments either side of
it: `lin`, `in`, `out`, `smooth`, `glide` and `hold`, or drag the handles in the lane for
anything in between. `in` writes the incoming side and `out` the outgoing one, so they are two
different numbers rather than two halves of one, and `hold` reaches into the next key because
holding a value across a segment means flattening both ends of it.

`ends` is the odd one and the one you probably want on a camera: it is about the *track*
rather than about the selected key, shaping the move's departure and its arrival in one press
and leaving every key between them alone. Press it from anywhere on the track.

This works on the camera track as well as on the look scalars, and what it shapes there is
*when* the camera arrives rather than where it goes. The route stays the Catmull-Rom through
your keys whatever the handles say — easing remaps the traversal and moves no key — which is
why the composition track can have a lane at all without contradicting the rule that a camera
move cannot be judged from a graph. The camera lane draws that remap directly: one ramp per
segment, rising from the key it leaves to the key it reaches, so a linear segment is a plain
diagonal and an eased one visibly is not. Judge the result in the world instead — the beads
on the path are sampled at equal intervals of program time, so they bunch where the camera is
slow and spread where it is fast.

**A camera move starts and stops at speed until you ease it, and `ends` is the one press that
fixes it.** The spline holds the end pose beyond the outer keys while its tangent there is
half the first segment's average velocity, so an unshaped move departs the first key and
arrives at the last with a step in speed rather than a ramp — measured on three keys dollying
4m over 4s, 0 to 0.63 m/s across a single 30fps output frame at the start, and 0.31 to 0 at
the end. After `ends` the same move departs at 0.0007 m/s and arrives at 0.0005, which is two
hundred times smaller and below anything a frame can show.

This used to be two presses of `smooth`, one on the first key and one on the last, with an
inviting wrong move in between: `smooth` on an *interior* key brings the camera to a near halt
as it passes, so easing "the whole move" by pressing every key produced a stutter at each one.
That still works and is still what you want when a deliberate pause at a key is the intent —
`ends` exists because the common case should not require knowing any of it.

**`glide` is `smooth` one degree up, and the difference is acceleration rather than speed.** A
cubic can bring the camera's *rate* to zero at a key but never its acceleration, so a `smooth`
departure still steps from no acceleration to some. `glide` puts two control points on each
side of the segment instead of one, which makes the timing curve the quintic
`6u⁵ − 15u⁴ + 10u³` — the shape whose first *and* second derivatives vanish at both ends. It
costs a slightly faster midpoint, 1.875× the average rate against the cubic's 1.724×. `ends`
applies the glide shape, so the one-press fix is already the C2 one.

**`+pt` and `−pt` set how many control points a key's handles carry**, which is the degree of
the segments either side. `+pt` is exact: the extra handle appears, every other one shifts to
keep the curve exactly where it was, and not a rendered frame changes — so it is safe to press
while judging a move. `−pt` cannot be exact, because a curve of one degree is not generally a
curve of the degree below, so removing a point moves the shape. Four points a side is the
ceiling. The retime curve is deliberately excluded from both: the argument that a handle
inside the unit box cannot run source time backwards is an argument about a cubic, and it does
not survive the extra degree.

**Glitch** tears bands of the feed sideways, and it is seven controls rather than
one because the interesting looks live off the diagonal. `amount` is the master and the one
worth keyframing — it scales density and shove together, so corruption fades in and out on a
single track. `density` is what fraction of the bands tear at a full master and `shove m` is
how far one travels, in metres in the room: sparse-and-violent and dense-and-subtle are the
two ends those give you, and neither is reachable from a single slider. `flare` is the cyan
a torn band burns, per metre it was shoved, so a bigger tear lights harder on its own.
`band rows` is the height of a band in the sensor's own scanlines — 424 over that many bands,
so 35 at the default of 12 — and `rate hz` is how often the torn set is redrawn, where 0
freezes the pattern where it stands rather than switching it off.

`axis` is which way the bands run, from the sensor's rows at 0 to its columns at 1, and the
fractions between are the point: at 0.5 the bands cross the frame on a diagonal, which is a
look neither end reaches. It is a blend of the two image axes rather than an angle in degrees,
because the bands are cut in the sensor's frame where 512 columns meet 424 rows and a band is
a run of scanlines rather than a distance — there is no square in which an angle would mean
what an angle means. The raster's `angle` under Post is the one that gets degrees, because it
runs in screen space where the pixels are square. Turning the axis changes which bands tear
and not which way they slide: the shove stays along sensor x, so a column of bands shears
across itself rather than along itself, and there is no separate shear control because the
pair that could disagree buys nothing the references show.

The tear is applied in the sensor's frame before the camera sees it, so it is only
screen-horizontal from head-on: orbit around a torn band and it shoves in depth instead, and
a levelled room tears along the angle the mount was really at. That is the effect saying the
*volume* is corrupt rather than the picture, and it is why the group sits at the displacement
stage next to what moves points rather than in `Post` next to `raster.amount`.

**`lattice.amount`** rebuilds the volume on a grid: every axis quantised to `cell m`, so surfaces
break into steps and the cloud reads as something being reconstructed rather than something
that was measured. It is the last displacement applied, after the tear, so what gets snapped
is where the point actually ends up — a grid cut before the turbulence would be smoothly
pushed back off itself. **It snaps in the levelled frame**, so the cells line up with the room
rather than with the bracket: level a canted mount afterwards and the grid does not re-cut.
The cell is metres in the room like the other displacements, so a look gives the same grid at
any export size.

**`glyph.amount`** draws every point as a character rather than as a round splat, and it has no grid
of its own — it rides `lattice.amount` and `cell`, which already cut the room into cubes and
move each point to the centre of the cube it falls in. One cell draws one character, so the
characters stand in the room at the size the room gives them and recede with it, which is
what a pass stamping text onto the finished frame could not draw at all. The master
crossfades the mark rather than switching it: at 0.5 every cell is a dot with a character
glowing inside it, and the sprite grows from `pointSize` to cell-sized along the same blend,
so one character comes to stand for one cube of room.

**Riding the lattice is why glyphs read as characters only near `lattice.amount` 1.0.** The lattice
is a blend from the measured surface to the reconstructed one rather than a switch, so at 0.5
each point sits halfway to its cell centre and you get several copies of one character
smeared along that path. At `lattice.amount` 1.0 with `glyph.amount` 0 you have the `voxel` recipe fully
engaged — every point on its cell centre, drawn as a round splat — and raising `glyph.amount` turns
those dots into characters without moving one of them. The shipped `voxel` document is not that
picture, and the difference is worth knowing before you reach for it as a reference: it names
`lattice.amount` 0.55 on a 3.5cm cell, halfway along the blend this paragraph opened on, so it keeps
some of the smear deliberately.
**At `lattice.amount` 0 with `glyph.amount` 1 the picture is mush**, because every one of the 217,088 points
draws a cell-sized character at its own unquantised position — that is authoring rather than a
defect, and nothing gates one control on the other.

**Three keys decide which character a cell draws, and they add and wrap rather than mixing.**
`tone key` reads where the cell sits between the clip planes, `hash key` reads a hash of the
cell itself, and `rain key` reads the falling counter passing through it; the three weights
sum into one index into a table of sixty-four 8x8 bitmasks and wrap. They sum rather than
blend the way the five readings do because character indices do not average — character 3
half-and-half with character 9 is character 6, an unrelated symbol rather than anything
between the two. All three are weights from 0 to 1, and `hash key` is the only one of them
that defaults to 1 rather than to 0 — so raising `glyph.amount` on its own gives the field one key,
the cell's, which is the reading the reference frames have. It reaches nothing while `glyph.amount`
is 0.

**The table is sorted by ink**, punctuation at the sparse end and dense kana at the other, so
the tone key reads it as a tone ramp and the hash key reads the same table as noise with
neither having to choose. What that costs is a latin ramp: a luminance sweep runs through
kana, so the picture is ASCII art drawn in an alphabet that is not ASCII.

**The tone key is a fact about the cell and not about the point, and that is what stops the
lattice turning it into noise.** It reads a range and not a colour, and the difference only shows
where a cell holds sources that disagree: collapse a few hundred depth texels onto one cell and a
key reading each point's own colour picks a different character for each of them, drawn at the
same snapped position, so the cell paints the union of several characters. On a `cascade`-shaped
fixture that is 30.65% of the frame inked against 8.66% — three and a half times the ink, and none
of it the character anybody asked for. There is no cell-constant reading of the drawn colour to
key on instead: the colour is built per fragment out of five readings and everything the tone
stage adds, and inside one cell it still varies through the camera texel, through the raw sample
depth, and through the rain's own lift. So the key reads the range. For `cascade` the two are the
same thing — it is `readDepth` alone, so its colour *is* the depth ramp read at that range — and
they part company furthest under `readRgb`, where a white shirt and the black wall behind it sit
at one depth and take one character.

**It only bites where the characters actually resolve, which bounds the whole thing and is the
first place a re-measurement goes wrong.** Below the legibility band `glyphMix` is 0, the mark is
a round splat, and the tone key reaches no pixel at all — so a build with the defect and a build
without it draw identical frames for a reason that has nothing to do with the key. On a 1080p
export `cascade`'s 5.5cm cell falls under the band past about four metres; on a 360-tall stage it
happens at about 1.2m, because at 4.1m that cell rasterises to 4.6 framebuffer pixels against
17.3 at 1.1m. Measured there, interleaved over three rounds against a build carrying the shipped
per-point key, every arm repeating its mask and its pixel count identically: a wall ramped ±120mm
about 2500mm inked 106,282 pixels against 114,537, and a flat wall at the same depth 36,340
against 40,207. The flat wall is the honest reading of the *meaning* change alone, since a
homogeneous cell has no occupants that can disagree; the ramped one carries the union defect on
top of it. Both arms had `fade` and `wake` forced to 0, which changes nothing about the character
— they scale alpha and never reach the index — and without which a point born on an injected
frame carries a fade of exactly 0 and the whole frame comes back black.

**The mark crossfades back to the round splat at whichever floor it hits first: the look's own,
between sixteen and eight reference pixels, or what the buffer can actually resolve**, so the
near room is text and the far room is texture. At full `glyph.amount` on `cascade`'s 5.5cm cell the
look's band is 4.0 to 8.0 metres out, the same metres at 1080p and in a 4K export; a buffer
shorter than 1080 pulls the boundary nearer because eight framebuffer pixels stop existing
sooner, which is the buffer being honest about what it can draw rather than the look changing.
Cut-away geometry is outside all of this and falls back to the round mask outright, because a
piece of scaffolding that is still legible is still reading as surface.
The reason the floor exists at all is that an 8x8 bitmask sampled
across eight pixels is a different random set of bits every time the camera moves rather than a
small character, which bloom then amplifies. Clamping the
sprite to a legible minimum instead would keep far cells readable and stop them being
cell-sized, which collapses the recession at depth into the flat screen grid a cell-per-cube
was chosen over. A keyed camera `fov` sweeps the band the same way walking closer does — a
zoom makes characters resolve out of texture mid-clip — and that is the recession being true
rather than a defect: the marks are objects in the room at a size the room gives them, and a
narrower field gives every object more pixels.

**`rain.amount`** is a term of its own rather than a setting inside the glyph field, and it works
over round splats. It computes one scalar per point out of world height and program time,
brightens what a drop head passes, and the glyph field's `rain key` reads that same scalar to
scramble the character — one source and two consumers, the arrangement `duotone` already has,
so a wave descending through a room is reachable for any look that is not drawing text and
`voxel` gets it for nothing. `fall m/s` is how fast a head descends, `head gap m` how many
metres of column separate one head from the next, and `trail m` how many metres of afterglow
sit above it: 0.55, 1.3 and 0.45 by default. Only `trail m` belongs to `rain.amount` alone — `fall
m/s` and `head gap m` shape the drop coordinate *both* consumers read, so with `rain.amount` at 0 and
`glyph.amount` and `rain key` up they still move the picture, by changing which character the passing
counter scrambles a cell to. With both masters at 0 none of the three reaches a pixel, which
is what keeps a look that never asked for any of this rendering the frame it always did. A head
every `head gap` metres rather than one head that wraps is what keeps two or three running in
a column at once, and the trail sitting *above* the head is what makes it read as falling
rather than as a band sliding through. Nothing in it accumulates — the value is a pure
function of program time and world position, so a seek lands on exactly the frame playback
would have drawn there, which `timeline-check` holds.

**The two groups sit at the two stages they belong to rather than together.** `Glyph` is
immediately after `Points`, because what mark gets drawn is what `Points` is about, and `Rain`
is beside `Style`, because what colour a point takes is what `Style` is about — so the rain's
home does not depend on glyphs being switched on. The cost that accepts is that the
falling-code look is authored in two places on the panel, and `cascade` is the shipped
document that holds it: the lattice at 1.0 on a 5.5cm cell, `glyph.amount` at 1.0, the hash key full
and the rain key at 0.6, the rain at 0.8 falling 0.55 m/s with heads 1.3m apart, over a depth
reading with a green duotone, a toe and bloom on top.

**Every effect is one panel group of its own, and a core group holds only the spine's own
controls.** Twelve effects used to draw loose inside `Style`, `Post`, `Displacement` and
`Region`, mixed in with `rim`, `bloom`, `crush`, `cell m` and the region box — so they had no
heading to collapse, and the hover-X that takes an effect out of the rack never appeared on
them, because `groupOwner` refuses a group with more than one owner. Each of them now declares
its own group and its own heading. The rule is a convention rather than a refusal: the install
door still accepts a parameter that names a core group, because an effect may one day have a
term that genuinely belongs beside the spine's, and a door that forbade it would be a rule
written where the exception cannot be made. A term under its own heading drops the prefix it
only carried to stay legible loose in a shared group, so `duotone hue` is `hue` and `streak
angle` is `angle`; `halation` and `stock` keep theirs, which is the inconsistency this convention
inherited rather than one it introduced.

**One effect is one group even when its terms belong to two stages.** `Turbulence` is the case:
three of its terms displace and the fourth, `scramble`, reads the region box, and they sit
together under one heading so the hover-X removes the whole effect rather than three quarters of
it. Where the slider is drawn and what the shader does are separate facts — `scramble` still
consumes the region service at gate order 200, between `push` and `mask`, wherever the panel puts
it.

**On the Look tab one row moved, and it had to.** `Thermal`, `Edges` and `Duotone` sit where
their rows sat inside `Style`, ahead of `Rain`; `RGB split`, `Grain`, `Streak` and `Vignette` sit
where theirs sat inside `Post`, ahead of `Datamosh`. A grouping change that also re-laid out the
panel would be two changes arriving as one, and the second is the one nobody asked for. The
exception is `crush`, which the registry declares after those four effects and which therefore
drew below them: a core group is emitted whole before the groups anchored under it, so a term
that stays in `Post` cannot stay below effects that have left it. `Post` is now `bloom` and
`crush` together, which is the pair the grade pass already describes - the rolloff and the
black-toe crush ride along with the same pass - so the one row this cost is a row that reads
better where it landed.

**The Region tab reads the box first and then the readings of it, in the order the shader takes
them.** `Region (metres)`, then `Region push`, `Turbulence`, `Region mask` and `Ripple` at gate
orders 100 to 400, then `Displacement` and `Lattice`. Reading down the tab is reading the
pipeline, which is worth more than keeping `Turbulence` next to the other thing that displaces:
a panel that draws its stages out of order teaches the wrong thing every time somebody looks
at it. **The two numbers are equal by hand and nothing holds them equal** — a fifth effect
consuming the region service, or a gate order changed without its panel order following, draws
the tab out of pipeline order and makes this paragraph wrong rather than merely stale. That
order is the reason `region` sits before `displacement`
in the panel spine, which is the one place the spine's order is a statement about meaning rather
than about history.

**`ripple.amount`** is the region read a fourth way, after displacing, scrambling and masking: a wave
travelling out along the radius, in metres at a full weight, so the volume breathes where
`push` only swells it. `per m` is its spacing and `hz` its speed — and the wave
advances in eighths of a cycle rather than sliding, which is the character rather than a
limitation: the surface arrives at each step instead of gliding between them, so it reads as
machinery rather than as breathing. A speed of 0 freezes it where it stands rather than
switching it off, the way `rate hz` does under Glitch, and both keyframe.

`turbulence` displaces points with a noise field. `near`/`far` is the most useful control
for isolating a person from the room. `cull speckle` drops points whose neighbours disagree,
cleaning up the sensor's edge noise (sigma ~= 3.5 + 1.3*d mm, so 4.6mm at 0.75m and 10mm at
4.25m). `render %` scales the drawing buffer and is the one control that reliably buys back
frame time, for the reason [rendering cost](performance.md#rendering-cost) gives.

Two controls decide how much white lands on the geometry, and they are the first to reach
for if the look is blown out. **`blackwall.scan`** keys off distance rather than screen position, so
it crosses an angled surface as a drifting diagonal band; wide and hot it reads as a light
leak, so it is kept narrow and cyan. **`rim`** brightens depth discontinuities and gives the
subject its edge, but under additive blending plus bloom it washes broad surfaces white, so
turn it down before turning down bloom.

**The seven grade terms share one pass, and the pass carries the tonemap.** `rgb split`,
`raster.amount`, `grain.amount`, `streak.amount`, `halation.amount`, `stock.amount` and
`vignette.amount` each switch it on, because a full-screen read and
write that changes nothing is worth skipping. What rides along with it is the highlight rolloff
and the black-toe crush, so a look with all seven at zero is not the same image without seven
effects: it also has lifted blacks and no rolloff, and additive accumulation clips to flat
white where it would otherwise keep its hue. Raising any one of the seven brings the grade back.
The vignette used to be part of that bundle and is now its own control, which is why a project
saved before it existed loses its corner falloff until it names one.

**`streak.amount`** bleeds light across the frame. Each pixel gathers back along the streak's axis and
keeps the brightest thing it finds, decayed by distance, so a highlight smears the way a sensor
smears one down a column of wells — sixteen taps at geometric spacing, reaching about 168 pixels
at the 1080p reference. `angle` beside it is which way, in degrees, and **0 is straight
down**, which is what this term did when it did nothing else: a look authored before the control
existed names no angle and keeps the fall it was graded with, to the bit. Positive turns the
smear clockwise on the glass, so 90 runs it across to the left, 180 sends it up and -90 across to
the right, and the same half-turn is reachable either way round. It is degrees rather than the
axis blend `axis` under Glitch gets, because this runs in the grade pass in screen space where
the pixels are square and an angle means what an angle means, where the tear is quantised in the
sensor's own frame and has no square to mean it in. It is a gather over the current frame rather
than a buffer that accumulates across frames: a buffer would smear along whatever the camera did
last, so an orbit would drag every streak sideways and a seek would arrive carrying the streak
the scrub built rather than the one playback would have.

**`halation.amount`** is the warm ring film puts around a highlight, with three settings under it
in a `Halation` group of its own on the raster's precedent — a term that grows sub-controls gets
a heading rather than crowding `Post`. What makes it worth having beside bloom is the colour. A bloom halo is the highlight's own colour spread
outward, so a cold window blooms cold; on film the light goes through the emulsion, scatters off
the base behind it and exposes it a second time, and what comes back is red-orange whatever
colour went in. So what this gathers is a brightness and not a colour: sixteen taps on a disc
around each pixel, each one counted by how far its luminance sits above `halation threshold` and
by how far away it is, and the colour comes from `halation tint` alone — 0 is deep red, 1 is
amber, and there is no hue control because a look asks how much of a ramp it wants rather than
for a different ramp. `halation radius` is how wide the ring is, in pixels at the 1080p
reference like every other screen-space term, and it widens the ring without dimming it: the
taps are normalised by their own distance weights, so what the falloff decides is the ring's
shape and not how much light is in it. Raise `halation threshold` and only the brightest things
scatter; drop it and the whole frame starts to glow. The three settings are inert while the
amount is at zero, which is what keeps them from switching the pass on by themselves.

**`trails`** is the buffer that paragraph rules out, and the one look term whose length is
counted in frames rather than in seconds. It hands its value straight to the afterimage pass's
damp, and that pass multiplies the picture it is holding once per rendered frame with nothing
in the expression about how long a frame lasted, so what the control sets is a number of
frames and not a duration: at 0.9 the trail is down to 12% after twenty of them, which is
0.83s of a 24fps deliverable and 0.33s of a 60fps one. `fade` and `wake` are in milliseconds
for the reason [surface memory](architecture.md#surface-memory) gives, and this term is the
exception to that rather than a second expression of it — so a look graded at one output rate
does not keep its trail at another. It applies to `reach` and `decay` under Datamosh as well and
to nothing else: those two passes are the only ones in the chain that carry anything from one
render to the next, and both count what they carry in renders.

**`datamosh.amount`** is the picture dissolving into vertical needles, and it is the one pass in
the chain that reads the frame it drew last time. Every frame the picture is pulled a little way
along Y and what it leaves behind does not clear, so a highlight stretches into a streak that
grows for as long as the pass remembers. `amount` is the master and the one worth keyframing: at
zero the pass is switched off and costs nothing, so the dissolve arrives and clears on one track.

`reach px` is how far the picture is pulled each rendered frame, in pixels at the 1080p reference,
and `decay` is what fraction of the trail survives a frame — the two together set how long a
needle is. The blend is a per-channel maximum rather than a mix, so a highlight leaves a needle
and the dark between the needles stays dark; a mix feeds the whole frame back into itself and
greys it over in about a second.

`splay` is which of the two readings of "vertically" you want. At 0 the whole frame drags one way,
and that way is up rather than down — the pass fills a fragment from below it, so there is no
setting that streams the picture downward as a sheet. At 1 it is pulled *away* from `line`, so everything above that
height streaks upward and everything below it streaks down, and the frame comes apart from the
middle out. `line` is where that split sits, as a fraction of frame height from the bottom.
`grain px` is how wide a column of the picture pulling by one amount is: at 1 the frame is a field
of separate needles, and at 16 it comes apart in ribbons. Ragged rather than a clean stretch is
the whole difference between this and a vertical zoom.

`drift` blends the fixed column pattern into the animated one, so its full range is exactly 0 to
1. The shader clamps that blend at both ends; exposing values above 1 would add dead slider travel.
`speed` sets the animated pattern's clock and does nothing while drift is zero.

`refresh s` is the one control that is not only a look: it is how long the pass is allowed to
remember, and every that many seconds of program time the picture snaps back to the frame it was
handed. That snap is the pulse the look wants and it is also what makes the timeline work — a seek
decodes forward from the last one, the way seeking to a keyframe does — so a long refresh is a
long dissolve *and* a long pre-roll on every scrub.

## Audio

The Audio panel imports one file, up to 64 MiB and ten minutes. FFmpeg converts it to stereo
48 kHz PCM. `--audio DIRECTORY` selects the asset store; the default is `audio/` under the
application root. Projects refer to the normalized asset by its SHA-256 hash. Moving a project
to another machine requires that asset as well as its captures. Missing or changed audio is
refused before the project opens.

Choose **Clip**, **Effect**, then **Parameter**. The effect list includes effects explicitly added
to that clip, effects with changed values or keyframes, and the current audio mapping. Adding
an effect makes it available immediately, even at its defaults. Project effects have a separate **Project**
entry. Depth is signed and uses the parameter's units. The result is the base or keyed value
plus depth times the signal, normalized to the parameter's range and step. The base and its
keys remain editable and are never replaced by the signal.

Low, Mid, and High split at 200 Hz and 2 kHz. Gain follows the EQ. Threshold and Ceiling map
the root mean square level to 0–1; Attack and Release smooth rises and falls. The spectrum
shows input and EQ output at the playhead, including while paused. These controls condition
the modulation; playback and export use the original audio. **Start** or dragging the audio
lane moves it in program seconds, independently of capture retiming.

The project saves its audio settings and mapping, and Undo restores them. MP4, MOV, and
lossless video exports include audio trimmed to the export range, with silence outside the
audio clip. PNG sequences are refused while audio is present. This prototype has one audio
clip and one scalar effect mapping. MIDI files, live MIDI, and microphone input are not
implemented.

## The edit, and what comes out of it

Two menus, because there are two questions and one of them used to answer both. **File >
Project settings** holds the shape the stage is letterboxed to and the rate the frames come
out at, and both are undoable document state. **Output > Export** holds the resolution, the
format, the output name and a readout of the trim the press will take, and all of those
belong to a deliverable — one of several files you might make from the edit.

**Nothing on either menu saves the edit, because it saves itself.** Every change that lands on
the undo stack is written to the project's own file, so there is no save entry and no shortcut for
one. The file the edit lives in is a third question and `File` answers it too: `Rename project`
opens a modal, because a name is typed, and `Duplicate project` stamps a copy and leaves you
editing the copy rather than the original — which is what forking an idea means once there is no
save to withhold. Deleting a project is on the projects page and deliberately not here, since
autosave would write the file straight back the moment you touched anything. `Cmd/Ctrl+O` goes to
the projects page.

**The shape is the edit's because the camera was keyed against a frame.** A 65:24 shot
reopened at 16:9 is a different shot with the same keys, which is the class of silent
reinterpretation the point-size rebase already taught this repo to refuse. The resolution is
*not* the edit's, and that is the same argument read the other way: every screen-space term
is expressed against 1080p and bloom's chain is frozen at 600 whatever the buffer is, so
1920x1080 and 1280x720 of one edit are the same picture and neither needs re-keying. So the
resolution menu offers only sizes of the project's shape — a size of another shape would be
a reframe, and reframing is what Project settings is for.

A project stores the shape as the reduced integer pair rather than as a ratio, and the two
are not interchangeable: the "1.90:1 DCI" the menu prints is really 1.8963, so a document
carrying that decimal would record a shape 0.2% away from the one the clip was composed
for and the editor would reframe it on the next open. `2048x1080` reduces to `[256, 135]`
exactly, and every other group in the table reduces exactly too.

**The rate is the edit's because `trails` is counted in output frames**, for the reason the
paragraph above gives — the same document at two rates is two different looks, so a rate
chosen per deliverable would mean two files of one edit carrying two grades with nothing on
screen saying so. Moving it also made a rate change undoable, which it had never been: the
handler committed to the stack, and the snapshot it compared held nothing for it to notice.

A deliverable saved by an older build names an output rate this build would ignore, so it is
refused at the picker rather than read — set the rate in Project settings and save it again.
A *project* saved by an older build carries an `outputSize` instead of a shape, and that one
is read rather than refused: its ratio is the shape it was framed at, and its pixels are
handed to the deliverable, so it renders exactly what it rendered before. A hand-typed size
of a shape the table has nothing for keeps its own size and lights no shape button, which is
honest rather than tidy — the stage really is that shape.

### A clip that needs an effect this build has not got

A look parameter is named after the effect it belongs to — `rain.speed`, `glyph.tone` — and a
document lists the effects it is built from. Open a clip whose list names one this machine
does not have, and the clip **opens**: the installed part renders, and the values and keys
under the missing effect are parked, which means they are carried and never evaluated. Saving
writes every parked key back holding exactly the value it arrived with, so working on somebody
else's clip on a machine without their effects costs nothing and destroys nothing. It is the
values that are preserved and not the file: the parked keys land after the installed ones and
the numbers go through a JSON round trip, so the document's revision moves. A name this build
simply does not know is still refused, and so is a name whose effect *is* here with a key that
is not — a typo and a half-installed package are both broken, and only a whole effect that is
absent gets parked. A document that names an effect only through a keyframe track and carries
none of its values is refused too, on the same rule as a document that names half of one:
every effect a clip uses arrives whole or not at all.

The application bar says so while such a clip is open: `missing: rain 1.0.0 — 4 values, 2
tracks parked`, one entry per missing effect, quoting the version the document was authored
against and counting what is being carried. Beside each entry is a **suppress** toggle.

**An effect that is here at another version gets a line on the same bar and nothing else**:
`document requires glyph 1.0.0, installed is 2.0.0`. The clip loads and the installed version
draws it, because a version string says nothing about which direction is compatible and
refusing would put a wall in front of every clip on the machine the first time an effect was
retuned. What the load owes is the sentence, since only the person reading it knows whether
the difference matters. There is no toggle beside it and export is not refused for it. The
notice goes on the next save, and that is the design rather than a bug: the list is derived
from what is installed, so saving records the version this machine actually built with.

**Export is refused while anything the clip needs is missing**, and the refusal names the
effects and their versions. That is the point of parking rather than the price of it: a video
leaves this machine and nothing in it says a layer of the look was absent when it was made, so
the one artifact that cannot explain itself is the one this build will not produce by accident.
Pressing **suppress** on an entry is the operator saying that this render may go without that
effect. It is per effect — suppress one while another is still missing and the export is still
refused, naming the other — and it is session state rather than document state, so it never
travels with the clip. **It is also per document**: opening another project ends every
suppression, even one missing the same effect, because a decision about this render of this
clip is not a decision about the next one. An undo keeps it, since an undo is the same clip.
The render's own record, the `.job.json` beside the video, carries a
`suppressed` list of the ids and versions it went without, and keeps the parked values, so the
file says what was skipped instead of pretending the clip never asked.

A queued render is the same rule with nobody watching. The job carries the effects its project
requires — **derived at the queue from the namespaces the project's own values and tracks
carry**, so a body whose list disagrees with its values is refused at enqueue by name rather
than queued and discovered inside a render — and a worker that has not got one of them **fails
the job with a reason naming it** rather than rendering, unless the job was queued with
`suppressEffects` covering it. A version the worker has and the job did not ask for is logged
and rendered, which is the same call the editor's notice makes.

**A job names one capture per clip**, by content hash, in project order. That list is derived
the same way and for the same reason: it comes off the clips rather than from the caller, so a
job disagreeing with its own document about the footage it renders is refused at enqueue naming
both lists. Repeats are kept and the order is the document's — two clips of one take is an edit
the list has to be able to spell, and two clips whose footage is swapped is a different edit
that has to read differently. The worker resolves every hash against its own library **before it
opens a browser**, and a hash it has not got fails the job naming *the take*. Then it loads the
project, which opens each clip's footage by hash, and **attests what the page actually opened
against what the job asked for, clip by clip and in order** — a set comparison would call a
render with two clips' footage swapped the one that was asked for. A worker also refuses a job
envelope from a version it does not read, naming the version: version 2 carries the list of
captures where version 1 carried a single string, and this repo ships no conversion.

The editor has no entry that comes up on no footage — `/edit` with neither a take nor a project
redirects to the projects page — so the worker brings the page up on the first clip's take and lets
the project open the rest. That bootstrap is the one thing here still resolving a hash to an id.

**A queue call that did not work is never read as a store with nothing in it.** The worker asks
its own server what is installed once per job, and what footage it holds once per job, and a
failed answer — a dropped connection, a 500, a proxy reporting its own failure with a 200 — is
retried a few times seconds apart before the job is failed at all. Both readings go through one
retry, so a server that cannot be reached says so in one voice however many routes a job needs.
If it still cannot read, the job comes back naming *the read*, never naming a package or a take
the machine has not got: those sentences send whoever is looking at the queue to different
machines, and only one of them is about the job.

### Installing an effect, and taking one away

`PUT /effects/<id>` installs a package, `DELETE /effects/<id>` removes one, and
`POST /effect-refusals` sets aside a package a page could not compile. The body is
`{manifest, chunks}` — the manifest as JSON and a map of file name to GLSL text — and the id in
the path is the namespace its parameters carry, so a manifest declaring a different one is
refused rather than guessed at. An id is lowercase letters and digits, up to 64 of them: it is a
directory name, and every copy this program renames out of the way is that name with a suffix on
it, so an id long enough to leave no room for one under `NAME_MAX` is a package nothing could set
aside once it was installed.

**An install lands in `effects/` and never in `effects-builtin/`**, which is the whole of the
fork mechanism: a package installed under a shipped id shadows it, and deleting that copy brings
the shipped one back. Nothing reachable from the network can edit or remove what the build shipped
with, so there is always a package to fall back to — and a `DELETE` aimed at a builtin nothing is
forking is refused by name rather than silently doing nothing. Deleting a package that exists only
in `effects/` uninstalls it, at which point every open document's values under it park exactly as
they would on a machine that never had it.

**Nothing here compiles GLSL, so the page that discovers a package will not link is what
quarantines it.** The door refuses a chunk naming something this build has not got and cannot
refuse one whose GLSL is merely wrong — a missing brace, a `vec3` assigned to a `float` — because
that is a shader that fails to link, which is a log line inside the driver rather than anything
the server can see. `warmPrograms` collects those failures and throws, so the page rolls back onto
the set it was holding; without somewhere to report it the store would go on serving the package
and every *fresh* page load would compile it at boot and die there. So the page posts to
`POST /effect-refusals` with the driver's own sentence, and `serveEffectRefusal` renames each user
copy aside under `<id>.<seq>.incompatible` — the same rename the boot gate makes, so the package
is still on disk to be repaired and the shipped one answers for that id again. The ids it names
are the packages that *changed* in that adoption, because a link failure is about the assembled
program and never says whose GLSL it was: the set the page was drawing with linked, so the culprit
is among the ones that arrived or moved revision, and all of them are named in the reason when it
is more than one. Only a link failure may do it. The same rollback catches a document this page
could not carry onto the new manifest, and `setAsideUnlinkable` is called on a mark the throw
carries rather than on the rollback having happened, because renaming a fork aside for a fault in
one clip is a page destroying somebody's work to report its own. The reason is cut to 500
characters and flattened to one line by both ends, and the flattening is of every control
character rather than of whitespace alone: this rig's driver answers a `float` assigned to a
`vec3` with 193 characters carrying two NUL bytes inside the sentence, and a NUL is not
whitespace, so a collapse of `\s` alone put one into a line somebody reads in a terminal. It grants no
authority the caller did not have, which is the first thing anybody asks about a route that
renames a directory on a name off the wire: `PUT` and `DELETE` are on this same server behind this
same guard and neither asks who is calling, and this does strictly less than either. An id with no
copy in the user root is skipped rather than refused, per id, because a page that failed to link
has the ids it was assembling from and no reason to know which root each came out of — the answer
names what was set aside and what was not, with a reason for each. The store's generation moves
when anything is set aside, so the page that just called it is handed the working set on its next
poll.

**A package that this build could not compile is refused at the door, and the refusal names the
rule it broke.** That matters more than it sounds: a package is GLSL spliced into two shader
programs and a table of parameters spliced into the registry, and both of those are assembled
while the page is still loading — so a bad package that landed would not fail its install, it
would fail the *next page load*, with nothing on screen and the only evidence in a console nobody
has open. So the door runs before a byte is written: the id and the manifest have to agree, the
package format has to be one this build reads (a later one is refused rather than adapted), a file
name has to be a bare name in the package's own directory, at most one parameter may be the
master and its default has to be the value the effect is absent at, the kind and the binding have
to be ones the registry implements, every uniform a parameter binds has to be declared by some
program and every uniform the package declares has to be bound by one of its own parameters or
listed under `hostDriven`, which is not a list a package writes freely — it names the uniforms
this build's own render loop drives, which is `rainPhase` and nothing else, because an exemption
a package issues itself is the rule gone — every joint a chunk names has to exist in a spine, and
every identifier a chunk reaches for has to be something this build has. Seven more rules are
about the package as a whole rather than about one entry in it, because every rule above is
satisfied as many times as a package repeats a correct entry: a package holds at most 64 files and
256 KiB of chunk text (the widest that ships holds eight files and under 17 kilobytes, and every
read of the store hashes every file of every package), its manifest holds at most 32 KiB (the
widest that ships is the glitch's at 2,740 bytes over seven parameters, and a manifest is written
to disk, hashed on every read and turned into a control per parameter on every open page — so
twelve thousand correct parameters carrying one small chunk of GLSL passes every rule above it and
fits inside a request body), a binding has to be the *shape* of the uniform it writes — `axisDeg`
and `centeredEdges` need a `vec2`, while `degToRad` and a plain binding need a `float` — and may
not aim at an array at all, since every
binding writes one cell and three.js takes its uploader off the declaration, a binding that
declares `gates` has to be something the grade gate can read, so not either vector transform,
whose two-component value is not a scalar amount, and not a table the gate does not collect, a
step may not be finer than `1e-6`, which is a grid neither the rounding nor a 32-bit float can resolve, and a
parameter may only name a panel group this build holds or one its own package declares, with a
package group key that collides with either refused by name. A parameter names its group and
nothing else about the panel: which tab it draws on is the group's fact, so a manifest carries no
tab of its own. It used to carry one that nothing read and that five effects stated wrongly,
which is the shape of thing a reader believes because no check ever contradicted it. A refused package leaves nothing
behind.

**A page that is open when an install happens rebuilds itself.** Both shader programs are
reassembled and swapped, the registry and the panel are rebuilt from the new set, and every value
is written back through the same door a slider uses — so the controls show what the registry
holds, the values in flight are where they were, and a newly installed effect's parked values
come back and apply. A newly installed package stays out of the sidebar until it is added or used.
What you were looking at survives it: the tab that was up stays up, a group
you had collapsed stays collapsed, and the preset picker still lists what it listed. Each of
those was read once at boot before, so after the first install the panel either lost them or went
on reporting a state it no longer had. A package that changed no GLSL is adopted without recompiling anything,
which is what keeps a retune from clearing the trails on a page mid-playback. Other browsers
converge on their own within a few seconds; the poll stands down while an export, a preset
gesture or a keyframe evaluation is running, because a rebuild between two frames of a render is
a file that changes look halfway through — and it asks again after its last read, so a gesture
that starts while it is reading defers it rather than being run over by it.

**A package this build stores and cannot compile is a rollback and a sentence.** The door checks
vocabulary and is not a compiler, so GLSL that is syntactically broken while naming only things
this build has gets through it — and a shader that will not link is a log line in WebGL rather
than an exception. The page detects it while it warms the swapped programs and refuses the
install: it goes back to the effects it was drawing with, keeps the document it had, and says
which shader did not compile.

A fork may add parameters and retune the ones it inherits. It may not **drop** one: the panel's
declaration order places every shipped parameter by hand, so a fork short of one is a build whose
registry cannot assemble at all, and that is refused at the door with the names it dropped.

**An upgrade can refuse a fork that was fine when you installed it, and it says so at startup
rather than at the next page load.** A fork is held against the build it was installed on, and
this program's shaders gain, lose and rename the joints a chunk can name — so a new build may not
be able to assemble a fork an old one accepted, and the fork would still shadow the shipped
package it forks. The store therefore asks the install door about every package in `effects/`
each time it starts. One the door now refuses is renamed to `<id>.<seq>.incompatible`, the shipped
package answers for that id again, and the log line names the id and the rule:

```
effect rain was installed by an earlier build of this program and this one refuses it: effect
rain does not assemble into this build's shaders: ... - the package has been renamed to
rain.4711.k2p9.incompatible rather than deleted, so it is still there to be repaired and moved
back, and the shipped package answers for that id again
```

Nothing deletes that directory. Fix what the sentence names, rename it back to `<id>`, and
restart — or install the repaired package over the top, which leaves the aside where it is for
you to remove by hand.

One package refused this way never costs its neighbours: each is held against the shipped set
plus the packages already validated beside it, so a fork that cannot assemble is renamed aside on
its own and the healthy ones next to it go on serving. And if the rename itself cannot be made —
a filesystem that refuses it, a name already taken sixteen ways — the server still comes up, says
so on the same line, and goes on serving the package it has just announced it cannot use. A build
that boots with a broken package is one you can read this log on; a build that will not boot is a
machine with nothing to read at all.

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

**The duotone sits on top of all five**, beside `thermal.amount` and `edges.amount` and for their reason:
a term written into one reading is inert in every other. It is a tonal transform rather than
a tint, because its two poles carry luminance as well as hue — the near one runs toward black
and the far one toward hot, so one term gives both the depth-keyed palette and the near-black
figure against a burning core. A plain global toe cannot draw that second thing at all, since
it darkens near and far alike, which is why there is no separate silhouette control to look
for. `duotone` is how far the image lands between the poles, `hue` turns both of
them together, and `split` is the depth they meet at, as a fraction of the clip range
— so the crossover is a place in the room rather than a fraction of the frame. The pair itself
is baked, the way `heatRamp` and `depthRamp` are: what is parameterised is how you use them.

**`duotone.motion`** keys those same two poles on speed as well, so whatever is moving through
the room comes out hot against a room graded by distance. It is the reading the depth key
cannot draw on its own: a subject and the wall behind it are graded by where they stand, so a
person walking through a scene is exactly as cold as the air they walk through until something
keys on the walking. The speed is axial and is measured from the two depth frames the renderer
already holds rather than from a flow pass, so what it sees is what the sensor sees — somebody
walking toward it rather than across it. A point reaches the hot pole at 1200 mm/s, about the
axial speed of an ordinary walk, and the amount pushes toward that pole rather than adding to
it, so the far half of a room is already hot and has nothing to gain while the effect keeps its
room where the picture is near-black, which is where a subject usually is. `snap mm` bounds it
at both ends: a jump larger than it reads as a different surface rather than as fast motion,
which is what stops every silhouette burning, and the same threshold caps the fastest speed a
pair can express at `snap mm` over the gap between the two frames — 7500 mm/s at the default
over a 30fps stream, and proportionally less over a slower link.

**The scanlines term is a raster now**, with three settings under it in a `Raster` group of
its own. `angle` turns it — at 0 it is the horizontal scanline it has always been, at 90 the
dense vertical column grille the reference frames slice a picture into — and because it keys,
a raster can rotate under the playhead. `pitch` is the line frequency, promoted from a literal
and defaulting to it — and **the settings worth having are below that default, not above it**,
because the wave is sized against 1080p and 1.3 is already about 220 cycles across the frame.
That is a television scanline; the wide bands the reference frames cut a picture into want
something under 0.6, and 0.1 is bands you can read across the room. The slider ends at 1.5 because
the settings above it only make a line thinner than the pixel drawing it, which is aliasing rather
than a raster.
`hardness` squares the wave into a grille with dark gaps between the
lines, and it is the one that makes the other two worth having: an angle over a sine only ever
buys rotated softness, where the references are hard line grilles.

They are settings of `raster.amount` rather than terms beside it, so only the master gates the
grade pass — raise the angle with the master at zero and nothing happens, which is deliberate,
since switching a full-screen pass on to draw nothing is the no-op the gate exists to refuse.
The angle is one parameter behind a two-component uniform, computed in double on the way
through for the reason `contour.width`'s two band edges are: taking the sine in the shader is
allowed to be a couple of thousandths off, and a raster meant to run along y then leaks a
whisker of x.

**`film stock`** is the emulsion's own colour, in a `Film stock` group of its own, and it keys
on exposure rather than on distance. That is what separates it from the duotone above: the
duotone is keyed to depth, replaces the colour outright and runs per point, where this biases
the colour the assembled frame already has — so a point, the bloom halo around it and the
halation ringing that halo are toned together, which nothing in the point program can do. It is
built to leave exposure alone, and it now does it for every colour rather than for the greys. The
tinted pixel is scaled back onto the luminance the pixel arrived with, so the outgoing luminance
is the incoming one by construction whatever the hue. The line that stood here divided the *tint*
by the tint's own luminance, which cancels only when every channel of the pixel is the same
number: worked through the shipped poles in double precision — arithmetic over the shader's own
literals rather than a rendered frame — the tungsten shadow pole took pure red to 0.8599 of its
luminance and pure blue to 1.2793, with the tungsten highlight pole running the other way at
1.1139 and 0.8067. Grey came back at exactly 1.0000 at all four poles, which is how a claim that
wrong survived being looked at, and it is also why the whole-frame reading recorded here (three
frames, mean luma 124.91 at one end of the balance against 125.06 at the other, 0.12%) could not
see it: a mean over a frame averages a red that has been pushed down against a blue that has been
pushed up, and a mostly-desaturated frame has little of either.

`stock balance` is the axis between two stocks and **its two halves are different shapes**. At
-1 it is a tungsten-balanced stock shot in daylight: shadows cool toward cyan-blue and highlights
stay warm, which is the split most people mean by a film look. At +1 it is the mismatch the
other way round and the whole frame sits warm, because both stocks put warm highlights up and
what actually walks along the axis is the shadow. `stock split` is the luminance where cool
becomes warm and `stock latitude` is how wide the crossover is either side of it — they go on
deciding where and how wide across the whole axis, they simply stop straddling a hue boundary
once the balance is past neutral. All three are settings of `stock.amount` and are inert while
it is at zero.

`crush` is the toe under the grade's Reinhard curve, promoted from a literal and defaulting to
it. It is a sub-control of the grade pass rather than an eighth term gating it — raise it on its
own and nothing happens, because the pass only runs when one of the seven terms above asks for
it. That asymmetry is deliberate: its default is not zero, so gating
on it would hold the pass open for every look there has ever been.

The panel is generated from the registry at boot. A parameter is one entry naming its group
and label, and the row, bounds, readout and keyframe control are built from that, so an
effect cannot get a control the registry does not own. Package-effect rows are hidden until
the effect is added with **+ add effect** or any of its values or tracks carries work.
Rows declared `under` another parameter are hidden while that master is at its absent value.
Removing one resets every value and deletes every track in one undoable edit, and it asks
nothing first: **remove** in the picker and the cross that appears on a group's own header when
you hover it are the same edit, and undo is what takes either of them back.
Explicit additions belong to the clip, or to the project for post effects, and are saved with
that look. Selecting another clip changes its effect rack. Space toggles playback even while
an inspector control has focus; Enter still activates buttons and selectors. The generator refuses to boot
if the rows it emitted are not the parameters that were declared.

The bounds are authoring travel, not mathematical limits. Mixes, angles and positions keep their
full semantic range. Amplifiers end where the live picture stops producing a useful new setting,
so a small pointer move remains a small change and the slider has no dead or destructive tail.
Every shipped preset sits on those same grids.

## Presets

Selecting Blackwall used to apply twelve post-chain values with it. They are separate now: a
preset is look values and nothing else. Framing is the shot rather than the look, so applying one
never moves your camera, a clip, its crop, its clip planes or its levelling.

**Applying one is not all on one clip.** A preset's cloud values — point size, the readings and
every effect that binds the cloud — land on the selected clip. Its post-chain values —
bloom, trails, crush, the rest of the grade — are the project's, so they land once and every
other clip in the edit is seen through them. That is a real consequence rather than a footnote:
applying a graded look to one clip of four regrades the other three. The editor says how many of
the values it just wrote were the shared half, and the save dialog says the same thing in words.

A preset is `{ version, values }`, plus a `requires` list when the look touches any effect,
and the keys it names in `values` are its scope. A parameter's key is dotted by the effect it
belongs to — `glyph.tone`, `raster.pitch` — and a core value that belongs to no effect stays
bare, like `pointSize` or `readDepth`. `requires` is `[{ id, version }]`, one entry per effect
the values touch, derived from them rather than typed: a look that never raises the rain
carries no entry for it. Twelve ship read-only from `presets-builtin/` and are marked `·` in the
picker. Five of them — `rgb`, `depth`,
`ghost`, `contour` and `blackwall` — are one per reading and differ in little else, so they
are where a grade starts, with `blackwall.json` carrying the twelve values the old mode
wrote. The other seven — `ember`, `grille`, `voxel`, `tearline`, `cascade`, `updraft` and
`rift` — are graded looks in their own right: all of them read Blackwall except `cascade`,
which reads depth, and each spends a duotone, a raster and a toe on top of that reading, so
applying one takes a finished grade rather than clearing the desk. `updraft` and `rift` are
`ember`'s grade with the datamosh over it and differ only in `datamosh.splay` — 0 streams the
whole frame upward, 1 pulls it apart from `datamosh.line` outward.
Nothing in the format marks the difference and nothing should — they are all documents, and
the split is editorial. A preset naming two values is equally valid, and applying it leaves
everything else where the grade left it.

**All twelve name the whole look**: the 27 bare core values every look owes, plus every parameter
of each effect the document itself touches — so picking one gives you that look whatever was
on screen before it. The all-or-none reading rule means all twelve also name the three reading
packages, Ghost, Contour and Blackwall, with all nine of their parameters. A shipped whole look
therefore names at least 36 values. `blackwall.json` claims five more effects whose fourteen
parameters bring it to 50. Applying a whole look resets every effect the document does not
claim back to that effect's own defaults, which is what makes leaving an ordinary effect out
and writing it in at its defaults describe the same look. Core framing — levelling, the clip planes
and the crop box — is the shot rather than the look, so no preset document can name it and
neither a look nor `none` reframes what you framed. An effect parameter remains a look value if
its manifest places its control in the Framing panel; panel placement is layout, not file meaning.
`library-check` holds the rule against the
registry: a new core value fails all twelve until each names it, and a new parameter added to an
effect fails only the documents whose `requires` already claims that effect — an effect
nothing has reached yet fails nothing, because nothing claims it.

Saving and exporting both ask which preset values go in, every box ticked by default, so a sparse
preset takes deliberate effort. A whole-look save still sheds what it can: an ordinary effect
sitting wholly at its own defaults leaves no trace in the saved file, because the whole-look
apply above restores that same effect to those same defaults whenever the document does not
claim it. The three reading packages stay whole even at their defaults, because a document
naming `readRgb` and `readDepth` must also carry the other three reading weights. A subset save
sheds nothing, because a picked value at its default is still a value somebody chose. The
boxes derive from the preset boundary in the registry, so a look parameter added later appears
under its own heading by existing and a framing parameter never appears there.

**The five reading weights tick and untick together.** A file naming any reading has to name
all five, because the ones it omits stay at whatever the clip was already wearing, and two
fifths of a blend renders as a mixture nobody authored. A file naming none of them is a look
that is not about the reading, which is fine. `refusePresetBody` refuses everything in
between.

**A partial preset does not stamp the clip**, because the stamp answers "what look is this
clip wearing" and a document short even one of the values its own core and effects call for
did not answer it. The two surfaces that report an apply say which of the two happened, and a
document naming the whole look stamps it. Framing is not part of that answer and a document that
tries to name it is refused before any value is written.

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

Documents from before the readings are version 3 and will not open, and there is nothing to
run: the one-shot conversion this repo used to ship was deleted once every document it could
act on had already been converted. This build reads version 8 alone. Version 8 adds audio
sources, mappings, and explicit effect additions per look. Version 7 documents are refused;
this prototype includes no migration. A version 6 document
carried one take at the top and one undivided look under it rather than a `clips` array, and a
version 5 document still spelled its parameters bare (`glyphTone` rather than `glyph.tone`) and
carried no `requires` list, so both are refused the same way a version 3 or 4 one is, and there
is no conversion for either. A file from
any older version is refused, naming its own version, and stays refused.
