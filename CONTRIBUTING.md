# Contributing

Braindance is a personal project and contributions are welcome. Bug reports, measurements
that disagree with the docs, and "this page is wrong" are as useful as patches.

## What you can work on

**With nothing but a checkout:**

- The browser side: the viewer, the timeline editor, the media library. `npm run fixtures`
  builds a synthetic capture to replay, and `npm run replay` serves it.
- The server's pure logic: the wire format, the index, the job queue, the origin guard.
  Several proof tools drive these with no sensor.
- The docs under `docs/`.

**With a capture or a corpus but no sensor:** registration, through `registration-check`
against a dumped corpus, and rendering cost, through the replay path.

**Only with a Kinect v2:** the grabber, delivered frame rate, and anything measured live on the
sensor. If you change one of those and cannot measure it, say so in the pull request. It gets
measured here before it lands, and that is a normal outcome.

If you have a sensor, please test on it.

## Running the checks

```bash
npm ci                        # the lockfile and the .npmrc release gate are the point
npx playwright install chromium
npm run fixtures              # a synthetic capture under captures/
npm test                      # syntax check, unit tests, supply-chain gate; no server needed
node tools/module-check.mjs   # the import graph in web/; CI runs this too
node tools/cpp-check.mjs      # both C++ files; needs a C++ compiler and turbojpeg's headers
node tools/<tool>-check.mjs   # one proof tool; most need a running server, a GPU browser or a sensor
```

CI runs `syntax-check`, `module-check`, `npm run test:unit`, `cpp-check` and
`release-gate-check`, plus every mutation of the four check tools. `release-gate-check` needs an
npm that knows `min-release-age` (npm 11 or newer) and access to the registry. The Chromium
install and the fixtures are for the proof tools, which CI does not run.

`CLAUDE.md` lists every proof tool with what it proves and what it needs.
[docs/proof-tools.md](docs/proof-tools.md) has the invocation, the fixtures and the mutation
controls for each.

Two rules when reading a proof tool's output:

- **Count failed assertions, never exit codes.** Zero failed assertions with a non-zero exit is
  a crash to investigate. `vendor-check`, `registration-check`, `registry-check` and
  `release-gate-check` exit 0 on a caught mutation.
- **A mutation anchors on source text.** If you change a line a mutation names, re-anchor the
  mutation in the same commit and say which ones moved.

## Before you open a pull request

1. Run the proof tools that cover the code you touched, and their mutations.
2. Say which tools you ran, which you could not, and why.
3. For anything user-visible, drive the real UI and describe what you saw.
4. Write the test for what you changed, revert the change, watch the test go red, then put the
   change back.
5. Include measurements for anything performance-shaped, with the method: window length,
   sample count, warmup discarded, page cache state. Interleave A/B runs.
6. If you add a claim to a proof tool, add the control that would falsify it.
   [docs/instruments.md](docs/instruments.md) says how.

## Style

- One implementation. No legacy path beside a new one, no compatibility flag.
- Comments are short: what a function does where the name is not enough, and a one-line why
  where a reader would otherwise break something. Long form goes in `docs/`.
- No emojis in console output, commits or comments.
- Commits: imperative subject, then a body with the why and any measurements with their
  method.

## Reporting

Open an issue. For anything you would rather not file in public, mail <tim@timkraus.eu>.
Say whether you found it by reading or by running, because a measured result and a reasoned
one are different claims.
