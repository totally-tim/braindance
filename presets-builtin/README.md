# The looks that ship

Twelve preset documents in the shape `PUT /presets/:name` writes and
`applyStoredPreset` reads: `{ version, requires, values }`. `requires` lists one entry
per effect the values touch. The store serves these from here and writes go to the user's
`presets/`, so saving over one forks it.

## Two kinds, told apart only here

| Kind | Documents | What they are |
| --- | --- | --- |
| readings | `rgb`, `depth`, `ghost`, `contour`, `blackwall` | one per reading, the neutral grade; where a grade starts. `blackwall` adds the post chain its mode always wrote |
| graded looks | `ember`, `grille`, `voxel`, `tearline`, `cascade`, `updraft`, `rift` | somebody's finished grade over one reading |

No field in the format says which kind a file is, and none should. A user's preset would have
to answer the same question, and it has no answer.

## Every document names the whole look

A shipped document names all core look values plus every parameter of each effect its
`requires` claims. `library-check` enforces this against the registry: a new core value fails
every document until each names it, and a new parameter on an effect fails the documents that
touch that effect. Picking a shipped look therefore gives you that look and nothing left over
from what was on screen before. The provenance stamp reads `applied voxel · <rev>` because
`wholeLookTag` recognises the document as complete.

**Framing is the shot, not the look.** `tilt`, `roll`, the clip planes and the crop box are in
the look tag because a project saves and keyframes them, but they are metres in the room, so
no shipped document names them. `none` is the control that resets them: it clears every look
value including framing.

**The five reading weights are all or none**, enforced by `refusePresetBody`. Two of five
leaves the other three at whatever the clip wore, which renders as a mixture nobody authored.
Naming none is legal. All twelve name all five.

**A preset you save is whatever you ticked.** Applying it leaves everything it does not name
where your grade left it. A document naming the whole look is a look; one naming part of it is
an adjustment.

When a value is added to the registry, close each document by reading the value back out of
the registry with that look on screen, not by typing a number into twelve files.

## Values worth knowing

- **Point sizes are 1080p pixels.** The five readings sit at 8.1 and 9. Six graded looks sit on Blackwall's 8.1;
  `voxel` names 6.5 because its lattice wants a smaller point.
- **`cascade` is the only document that draws the glyph field**: depth reading,
  `lattice.amount` 1.0 on a 5.5 cm cell, `glyph.amount` 1.0, hash key full, rain key 0.6, rain at
  0.8 falling 0.55 m/s with heads 1.3 m apart and 0.45 m of trail, under a green duotone, a toe,
  a low-weight hard raster and a little bloom.
- **`updraft` and `rift` are `ember`'s grade with the datamosh raised**, and differ only in
  their datamosh values. `datamosh.splay` is the one that changes the picture's shape: 0 streams
  the whole frame upward, 1 pulls it apart from `datamosh.line` outward. `updraft` runs 14
  pixels of reach at 0.92 decay over 6-pixel columns with a refresh of 1.6; `rift` 20 at 0.9
  over 2-pixel columns with a refresh of 1.2. `rift`'s line at 0.55 needs a subject that
  straddles it: the pull ramps over `(vUv.y - line) * 8`, so a frame wholly above the line
  renders what `updraft` renders. Those datamosh numbers are checked over
  `captures/fixture-long.knct`, a flat synthetic wall, and not graded on footage. A re-grade
  on a real take is expected.
- **`voxel`'s exposure is 5.65.** The glyph field's energy compensation darkens a lattice
  whose sprite is smaller than its cell, and `voxel` (point 6.5 on a 3.5 cm cell,
  `glyph.amount` 0) is the only shipped document it darkens. The value is the interior
  minimum of a 43-candidate sweep matching mean channel against reference frames, read back
  out of the registry. `cascade` is untouched because a full-size glyph makes the factor 1.
- **`determinism-check` reads `rift`** because it raises every accumulator the program has:
  trails, surface memory and the mosh.
