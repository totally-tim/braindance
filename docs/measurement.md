# Taking a number in this repo

The procedure for measuring something here and reporting it. `docs/instruments.md` is how to
write a check that must fail when the thing under test is broken. `docs/performance.md` is the
numbers already taken.

## The procedure

1. **Interleave the arms.** Alternate A and B round by round and difference inside a round. The
   baseline on this rig drifts by more than most of what gets measured, so a sequential
   before/after reports an unchanged arm as a change.
2. **Discard the warmup and state how much.** A first frame that engages a shader pays its
   compile, and a first read of a capture pays the page cache.
3. **Pace the clock the way the question asks.** Back-to-back renders price a term's marginal GPU
   work and renders paced one per animation frame price what a viewer waits for, and the two
   differ by about 4x, so say which a figure is.
4. **Read the health number the run reports, and throw the run away when it is wrong.**
5. **Verify the position, not just the request.** A seek can resolve without moving, so check the
   playhead against what was asked for, retry, and report the count of stand-downs.
6. **State the method with every number**: window length, sample count, warmup discarded, page
   cache state, fixture or capture, drawing buffer, hardware, and machine load.
7. **Count failed assertions, never exit codes.**

## Health numbers and their thresholds

| measurement | health number | throw the run away when |
| --- | --- | --- |
| profiling per-segment cost on the grabber | delivered fps | it does not sustain ~30.0. The loop idles 55% of every interval, so a run below that was competing for the machine and its per-segment timings are noise. `tools/prof-summary.mjs` flags such a run under 29.5 fps. In a throughput experiment the opposite holds: delivered fps is the result, so a drop is the finding and discarding it discards what you set out to measure |
| `tools/monitor-cost-ab.mjs` | the spread of the no-client arms | the spread exceeds `--max-baseline-spread`, default 0.8 fps. A continuously recording run legitimately sits at 29.86 over two minutes, so an absolute floor borrowed from a profiling run throws away good data |
| `tools/layering-ab.mjs` | three per-block gates plus a drift gate | a block missed a frame, fetched inside itself, failed to draw and warm the clips its arm declares, or raised a page error; or the one-clip arm's first-half median moves against its second-half by more than that arm's interquartile spread |
| any paired A/B | a null control, plus a positive control on the resource under measurement | the null arm's quartile band does not contain zero, or the positive control does not resolve. Match that control to the resource: GPU fill for a shader term, and its own equivalent for a CPU, disk or capture-throughput arm. An arm whose own band straddles zero is reported as under floor, never as a value |
| a browser drag or gesture | a frame counter installed in the page | the count came from the driver's own loop. `page.mouse.move` does not return until the page has processed the event, so dividing 60 moves by 15.1 elapsed seconds reports 4 frames a second where the page's own count is 12.4/s, 10.0 to 18.1 across five rounds. Read `globalThis.__orbitFrames`, incremented from a `requestAnimationFrame` chain, as a delta around the gesture, the way `tools/editor-check.mjs` does beside `navigationRedraws` |

Contention shows as variance and non-monotonicity, not as a low absolute level: six arms at
30.03 to 30.04 fps is a settled rig, three windows at 28.90, 29.19 and 28.83 are a spread of 0.36
and also settled, and registration p50 swinging 11.50 / 13.65 / 8.30 ms across three rounds of one
arm is contention whatever the fps reads. `captures/` and `vendor/` carry `.metadata_never_index`,
because Spotlight indexing them produces that signature.

Prefer a counter the page already keeps to a rate you compute: a 40-move drag's draft count reads
1818, 1818 and 1869 across three runs of one A/B where the frame rate moves with the machine.

## Two pieces of hardware read differently from how they measure

**The GPU answers the clock before it has drawn.** `gl.finish()` does not fence on ANGLE's Metal
backend: 50 renders of a 434,176-point cloud into a 1052x592 buffer, with `gl.finish()` after the
loop, time 0.022 ms per render against the 0.83 ms the same pass measures paced, so what is timed
is the JavaScript that queues the work. Pace renders by the animation loop, where the compositor
forces the frame to complete, or read the GPU's own timer query. The renderer string is no tell
either: `gl.getParameter(gl.RENDERER)` answers `WebKit WebGL`, which reads like a software
fallback and is not one, while `WEBGL_debug_renderer_info` reports
`ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)`.

**The Mac's USB topology reads worse than it measures.** `ioreg -p IOUSB -w0` shows the sensor as
controller -> `USB3.0 Hub` -> `NuiSensor Adaptor` -> `Xbox NUI Sensor`, with a gigabit ethernet
adapter on the same hub, which looks like the degraded topology in `docs/performance.md` that
measures 12.82 fps. It is not: this rig sustains 30.02 fps with 2 subsequence warnings in 1921
frames, because the hub is a good one and the box count is not what matters. Settle it by running
the grabber and reading delivered fps. Use `ioreg`. `system_profiler SPUSBDataType` returns nothing at
all here, so a check built on it reads "no Kinect attached" either way.

## Traps

| trap | the rule |
| --- | --- |
| a tight loop cannot measure an allocation | the allocator hands the same block straight back, so the baseline arm is already effectively persistent. An offline harness is for correctness and `grabber --profile` on the sensor is for cost; a screening measurement that removes the effect will confidently report its absence |
| synthetic pictures cannot price a live image path | use generated images to test an encoder and real producer content to price it |
| a route's cost is per item | measure it against a library the size of a shoot, because a fixture-sized library reports a constant where you need a slope. Cold and warm are different quantities |
| a counter reporting zero may be counting a string nothing emits | grep the raw log and confirm the phrase appears at all before believing a counter that reports no change. A phrase in a tool's own help text is not evidence the running build emits it, and a zero delta from a wrong pattern is indistinguishable from a real absence |
| a gate calibrated on earlier runs and then passed marginally is not a gate | when the deciding run clears a threshold set from earlier runs by a margin smaller than those runs' spread — 0.04 against spreads of a few tenths — record that column as measured once, with no replication behind it |
| a speed read off two adjacent frames has a noise floor that moves with the frame rate | the sensor's depth jitter is a displacement of about 4 mm either way, so dividing by the gap turns a fixed quantity into one that grows with the link: 31 mm/s across the 128 ms pairs `registry-check` pins and about 140 mm/s across a capture's own 32 ms ones. Measure at two intervals, since whatever holds its millimetres is the sensor talking to itself where whatever holds its millimetres per second is movement, and state no jitter threshold in mm/s or in mm |

## Substituting a uniform for a shader literal is two questions

The value is one and the expression is the other. Hash every reading against the build from before
the change and expect exact equality.

- **`pow(x, 1.0)` is not `x`.** This GPU evaluates it as exp2 of the log2 and it lands a few
  last-bit values away. A uniform standing in for a literal exponent is exact; asking for the
  power of one is not.
- **A bit-identical value is not a bit-identical expression.** Guarding a gamma with a ternary and
  handing the ramp the resulting variable produces a third image, because the compiler contracts a
  subtraction inside the call into one multiply-add and does not contract it through a variable.
  Reach the old expression: put the branch around the whole statement so the default path is the
  old line.
- **Do the arithmetic in double on the CPU.** `f32(0.5) - f32(0.08)` is 0.42000001668930054 where
  the literal `0.42` it replaces is 0.41999998688697815, so the contour band edges are halved
  either side of the middle in double and uploaded as the one `contourEdges` vec2 the package
  declares.
- **Guard a `mix(x, y, 1.0)`**, since `x + (y - x)` is not always `y`.

## Driving a capture node over ssh

Detach a long-lived remote process and poll for readiness, because `await ssh(...)` does not
return until the channel has no holders and a backgrounded process holds it whatever `nohup` and
`< /dev/null` are given. Ship a multi-line script base64, because through `bash -c "..."` the
outer shell expands every `$(...)` first and JSON quoting carries newlines as two literal
characters. Resolve listeners by port through `ss`, because `pkill -f` matches the remote shell
running your own command.
