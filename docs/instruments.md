# Writing a check that proves something

Read this before writing or changing a proof tool. `docs/measurement.md` is the page for a number
you report, and `docs/proof-tools.md` is the per-tool reference.

## Enforce the claim, do not assert it

Ask what a broken implementation would have to do to still pass this row, and close that. Every
tool carries a falsification control: an edit that must fail the rows carrying the claim when the
thing under test is not doing the work.

`vcam-check` section 2 claims the bytes served to a webcam client are the bytes the encoder
emitted. A build that decodes and re-encodes every frame in flight passes a row that hashes a
served part against the set of served parts, because that set holds the part, and the conjunct
asking for a 64-character digest is true of every sha256. The writer logs the sha256 of each part
body as a column of its own, and the row now fails any served part whose hash is absent from the
emit log, over a floor requiring the log to be non-empty. When the two ends of a comparison share
no quantity, make the writer produce one.

A pairing that only agrees on timestamps is not a pairing the check has seen: the deterministic
encoder test blocks the first colour write and submits the next colour before releasing it, and a
build that merely re-stamps timestamps passes every timestamp row. `hd-encoder-check` decodes
distinct colours and depths so the image assertion is what fails, and held colour is a separate
arm, because its timestamp must stay older than the next depth frame's. The `/key` browser check
waits for a frame after the new crop state arrives, because a frame counted before that arrival
still shows the old crop, and its decode gate decides whether to hold at entry, because deciding
after an `await` can hold only half of a pair.

## Mutation-test the instrument

Break the thing under test on purpose and read which rows fire. Before believing a mutation was
missed, confirm it changed something; before believing one was caught, confirm it was caught for
the reason claimed.

`effect-check` claims the effect poll refuses a listing whose body carries no effects array.
Defusing the array check alone leaves the entry loop behind it iterating `undefined` and throwing
inside the poll's own catch, where a restarting server is already handled, so the mutated build
behaves exactly like the fixed one and the run prints NOT CAUGHT, which reads like a row that
cannot see. The control defuses both terms, which is the smallest edit that reproduces the defect.
The shape to recognise is a guard downstream of the line a mutation edits: it turns the mutation
into a no-op, and a no-op mutation and a blind instrument print the same verdict.

## Count failed assertions, never exit codes

Read the line the tool printed and which assertions fired. Zero failed assertions on a non-zero
exit is a crash or a printed miss, never a catch: a mutation run that reddens nothing prints
NOT CAUGHT and exits 1 with a count of zero.

`monitor-check` claims a decimated frame reaches the viewer as the grid it was sent at. Counting
harness exceptions in the same variable as assertion failures lets a driver timeout satisfy the
mutation verdict: one assertion fires, the line reads `caught, as required (1 assertion fired)`,
and nothing about sample placement has been put to that build. A throw sets `crashed` now, the
verdict is DID NOT RUN at exit 2, and it is decided before the mutation verdict and before
UNTESTED. A proof tool may not count its own crash as a finding in either direction.

## Place a probe where its answer would differ

Ask what a build with the defect would agree with, and stand somewhere it cannot. A set of arms
that agree about a quantity cannot measure it, however many of them there are.

`export-check` claims every screen-space term is expressed against 1080p, so a look holds its size
at any output size. A build scaling by `bufferWidth / 1728` instead of `bufferHeight / 1080` comes
out bit-identical on four arms that are all aspect ratio 1.6, because at 1.6 those two expressions
are the same number, while it draws 11.1% too large at every size the menu offers. The swept arms
shared one ratio and the shipped list does not: `web/export-sizes.js` groups its sizes under
16:9, 1.90:1 DCI, 4:3, 1:1 and 65:24, and none of them is 1.6. The check reads that list off the
page, and a cross-build arm at 1920x1080 separates the two builds.

## Look for the object every observation skips

Ask not only what your arms agree about, but whether there is an object here that every
observation happens to miss. Be most suspicious where the skipping was deliberate: an exclusion
with a reason attached is the one nobody looks at twice.

`library-check`'s route sweep claims no read route changes anything. A read route appending 64KB
to the take being recorded satisfies every arm in the section: the open take's size and
modification time are excluded from the snapshot by name because they move on their own, no write
counter covers the captures directory because the counters were built for the document stores, and
the recorder's state field tracks the recorder and not the file. Each exclusion is correct alone,
and together they leave the most valuable object in the system unwatched. The sweep asserts bytes
written against on-disk size once the take closes, where nothing is in flight and the identity is
exact.

## Close the class, not the instance

Make the table be the dispatch and have the check walk it, so a member added later is asked by
existing. Ask the correspondence from both ends as well, because a sweep that reads its domain off
the subject reports full coverage of the empty set the day the subject shrinks.

`library-check` claims every route that changes something checks its method, its content type and
its origin. Poking routes one at a time closes the ones on the list and leaves the next route
anybody adds outside it. The routes are one table that is the dispatch now, served at
`/library/routes`, and the sweep drives every entry at a concrete URL, asks each write handler
those three questions, and names any route it cannot build a URL for. The control adds a mutating
handler to that table in a `read` slot, and what catches it is a snapshot of every store, because
a count of registered routes cannot answer whether a read handler wrote something. What the walk
cannot see is a handler dispatched outside the table.

## Assert against the resource, not the bookkeeping

A number the thing under test reports about itself is a claim, not a reading. Ask the resource.

`/library/descriptors` claims how many capture descriptors are open. A build that drops the map
entry while leaving the `FileHandle` open makes `openCaptures.size` fall as the real count rises,
so an arm reading it records a release while a descriptor leaks, 0 against a real 2. The route
reports `readdirSync('/dev/fd').length` beside it and the arm asserts on that. Ask the same of any
count a proof tool reads back from the thing under test.

## Re-run the baseline in the failure's conditions

Before believing a proof tool caught your change, run the unmodified tree in the conditions the
failure happened in. A machine another agent is working on fails a check in a way that reads
exactly like a finding.

Contention kills a page evaluate mid-run, so `library-check` stops partway with its later rows
unasked. A baseline taken on an idle machine passes, so the two readings together look like a
regression with a clean control standing over it. The unmodified tree run back to back in the same
conditions stops the same way, which is the reading that separates the instrument from the change.
Check for another proof-tool run in flight before you start: on this machine, another agent's run
is the normal state.

## Things that bite in a browser

- A modal ends a run the way a healthy suite ends: a click behind an open `<dialog>` retries until
  the timeout, and the tool prints its assertion count with every later section unreached.
- A mutation that removes a control hangs the check that presses it, because a click waits for the
  control to become actionable; read the disabled state and assert on it instead.
- A driver pressing a control the page also presses on a timer is turned away by the reentrancy
  guard, so wait for the state the row is about and never for your own call to return.
- A seek can resolve without moving: `settled()` can return before the seek it waited on has been
  applied, so a seek-then-assert row is suspect before it is a finding.
- A gitignored fixture is a term in the assertion — a literal in seconds or pixels is a claim about
  that machine's `captures/`, so take it as a fraction of the measured duration and read the page's
  own scale back off where it drew.
- `waitUntil: 'load'` does not mean the page is up, because the handle publishes after that event;
  a readiness wait has to name what its own section reaches.
- A wait written with `?.` and compared against `null` is not a wait: `undefined !== null` is true,
  so the predicate passes before the page boots and the timeout is unreachable.
- `page.evaluate(fnSourceString, arg)` evaluates the string and never calls the function; the house
  pattern is `page.evaluate(\`(${FN})(${JSON.stringify(opts)})\`)`.
- Send probe values into the page as source: `JSON.stringify` turns `NaN` into `null`, drops an
  object key whose value is `undefined`, and writes `null` for either inside an array. A file on
  disk carries `__proto__` as an own property, which `JSON.parse`, `Object.defineProperty` and the
  computed key `{['__proto__']: v}` all create, while the plain assignment `p.x.__proto__ = v` sets
  the prototype and creates no own property at all.
- The panel is fixed over the stage, so a screenshot clipped to the stage counts panel pixels; hide
  the overlay for the length of the shot.
- Two renders of one camera pose differ while the orbit controls still hold momentum, so drain the
  damping before comparing frames and hit-test the region a comparison covers.
- A tool holding its own copy of a layout constant fails looking exactly like a product regression;
  ask the page for the number and read the drawing buffer back until it is the size you asked for.
- Wait for the take to open and resize events to run before accepting that size. `export-check`
  records the settled buffer and refuses every frame read after it moves, including cross-build pages.
- Writing `.value` by hand stops meaning what it says the moment a control's scale changes, and it
  fails in the passing direction, so check the quantity that came out against the one that went in.
- `camera.project()` answers in canvas coordinates and `page.mouse` takes viewport ones; they are
  the same number only while the canvas sits at the window's corner.
- A backtick inside a comment inside a template literal ends the literal, and the parse error names
  a word in prose, so name things in plain words inside page source strings.