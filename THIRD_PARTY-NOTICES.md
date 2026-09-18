# Third-party notices

This project is licensed under the Apache License, Version 2.0 (see `LICENSE`),
and `NOTICE` carries the attributions that Apache-2.0 §4(d) requires a
redistributor to pass on. This file is the longer version: what third-party code
this project ships, what it merely links against, and under what terms.

The release is **source only**. `vendor/` and `native/build/` are gitignored, so
no compiled artifact of any dependency is distributed here — everything under
"Not redistributed" below is something you install yourself before building.

## Redistributed in this repository

### libfreenect2 — `third_party/libfreenect2/`

Upstream v0.2.1 at commit `fd64c5d9b214df6f6a55b4419357e51083f15d93`, from
<https://github.com/OpenKinect/libfreenect2>. Copyright (c) 2014-2015 individual
OpenKinect contributors. Developed as part of the OpenKinect Project,
<http://www.openkinect.org/>.

libfreenect2's own source is offered under **either** the Apache License,
Version 2.0 **or** the GNU General Public License, version 2.0, at the
recipient's option. **This project takes the Apache License, Version 2.0 arm**,
which is what makes an Apache-2.0 licence on the combined work coherent.

The vendored source itself is passed on with both arms intact rather than with
the GPL one deleted, so you get the same choice upstream gave us. That is the
first of the three redistribution forms upstream's file headers offer: headers
left intact, accompanied by both license files. So
`third_party/libfreenect2/APACHE20` and `third_party/libfreenect2/GPL2` ship
unmodified, as does `third_party/libfreenect2/CONTRIB`, which those same headers
make a condition of redistribution. Upstream publishes no `NOTICE` file of its
own, so there is no upstream NOTICE text to carry forward — the attribution
above comes from the file headers and `depends/LICENSES.txt`.

Five files are modified. Each carries a notice of the change in its header, as
Apache-2.0 §4(b) requires, and `third_party/UPSTREAM.md` explains what changed
and why:

- `src/depth_packet_stream_parser.cpp` — accept depth frames missing only the
  unused 10th sub-image.
- `src/registration.cpp` — thread the occlusion filter, banded by linear index.
- `src/libfreenect2.cpp` — let the two USB link setup calls fail without failing
  the open, on macOS only.
- `include/libfreenect2/packet_pipeline.h` — declare `ColorDecoder`,
  `defaultColorDecoder` and a decoder overload per pipeline.
- `src/packet_pipeline.cpp` — pick the colour decoder by name, prefer software
  decode, and never substitute.

Those notices sit inside content that `tools/vendor-check.mjs` pins by blob hash,
so removing one fails the check rather than going unnoticed. Nothing else in the
tree is changed and nothing is removed.

One further copy of upstream code lives outside that directory:
`third_party/oracle/registration.cpp` is upstream's own `src/registration.cpp`,
unmodified and with its header intact, kept as the reference
`tools/registration-check.mjs` measures our threaded build against. Same
copyright and same dual license as the rest of libfreenect2. `vendor-check`
asserts it still hashes to upstream's blob, which is what stops it drifting into
a copy of our file wearing upstream's name.

#### Components inside libfreenect2 under their own terms

Upstream's `third_party/libfreenect2/depends/LICENSES.txt` is written for its
Windows binary release; the list below was instead read off the files this
repository actually ships.

- **`include/internal/CL/cl.hpp`** — Copyright (c) 2008-2015 The Khronos Group
  Inc. Khronos "Materials" permission notice, MIT-style. Full text in the file
  header.
- **`src/tinythread/tinythread.cpp`, `src/tinythread/tinythread.h`** —
  Copyright (c) 2010-2012 Marcus Geelnard. zlib/libpng license.
- **`src/flextGL.cpp`, `src/flextGL.h`** — generated from flextGL
  (<https://github.com/ginkgo/flextGL>), Copyright (C) 2011 Thomas Weber. MIT
  license. **These two files carry no in-file license header**; the grant is
  recorded only in `depends/LICENSES.txt`.
- **`src/openni2/*`** — Copyright (c) 2014 Benn Snyder, 2015 individual
  OpenKinect contributors; `DeviceDriver.cpp` additionally Copyright 2013 Benn
  Snyder <benn.snyder@gmail.com>. Same dual Apache-2.0 / GPL-2.0 terms as
  libfreenect2 proper, so the Apache-2.0 election above covers these too.
- **`cmake_modules/FindOpenCL.cmake`** — Copyright 2014 Matthaeus G. Chajdas.
  BSD 3-Clause (the CMake module form, naming Kitware and the Insight Software
  Consortium in its non-endorsement clause).
- **`tools/streamer_recorder/include/msdirent.h`** — Copyright (C) 2006 Toni
  Ronkko. MIT license.
- **`tools/streamer_recorder/PracticalSocket.cpp`,
  `tools/streamer_recorder/include/PracticalSocket.h`** — Copyright (C) 2002
  Michael J. Donahoo and Kenneth L. Calvert. **GNU General Public License,
  version 2 or later, with no Apache alternative** — these are the one pair of
  files in the vendored tree that the Apache-2.0 election does not reach. They
  belong to upstream's optional `streamer_recorder` example, which
  `BUILD_STREAMER_RECORDER` leaves **OFF** by default, so nothing this project
  builds compiles or links them. They are present because the vendored tree is
  upstream's tree with nothing trimmed — every file removed is a file
  `third_party/libfreenect2.manifest` could no longer vouch for — and they are
  distributed as a separate work on the same medium rather than as part of this
  project. If you build with `BUILD_STREAMER_RECORDER=ON`, the resulting binary
  is a GPL-2.0 work and its terms are yours to satisfy.

## Not redistributed — installed before building or running

Nothing below ships in this repository. The licenses are noted because the
software you build and run links against them.

### npm packages, installed by `npm install`

`node_modules/` is gitignored. The server also serves `node_modules/three` to
the browser at `/vendor/three/`, so a deployment does redistribute it.

- **three** 0.185.1 — MIT license. Copyright © 2010-2026 three.js authors.
- **ws** 8.21.1 — MIT license. Copyright (c) 2011 Einar Otto Stangvik,
  (c) 2013 Arnout Kazemier and contributors, (c) 2016 Luigi Pinca and
  contributors.

### System libraries linked by the native build

- **libusb** (<https://github.com/libusb/libusb>) — GNU Lesser General Public
  License, version 2.1 or later. Copyright (C) 2001-2015 libusb authors.
  libfreenect2 links it to talk to the sensor. Installed as a system package
  (`brew install libusb`, or the distribution's `libusb-1.0-0-dev`).
- **TurboJPEG** from libjpeg-turbo (<https://libjpeg-turbo.org/>) — the
  TurboJPEG API library is BSD 3-Clause, over a codebase carrying the
  Independent JPEG Group's terms. Copyright (C) 1991-2012 Thomas G. Lane, Guido
  Vollbeding; Copyright (C) 1999-2006 MIYASAKA Masaru; Copyright (C) 2009-2011
  D. R. Commander; Copyright (C) 2009 Pierre Ossman for Cendio AB; Copyright (C)
  2009-2011 Nokia Corporation and/or its subsidiary(-ies).

  The IJG terms require an acknowledgment, so, as clause (2) asks:
  **this software is based in part on the work of the Independent JPEG Group.**

  libfreenect2 decodes the sensor's colour stream with it wherever
  `--color-decoder` names `turbojpeg`, and `native/grabber.cpp` uses it to
  re-encode the registered frame on every build. Upstream makes it a required
  dependency of any build without VideoToolbox, so every Linux build carries it
  and defaults to it. Installed as a system package (`brew install
  jpeg-turbo`, or `libturbojpeg0-dev`).
- **OpenCL** — the depth solve runs through OpenCL on macOS. No OpenCL
  implementation is redistributed; the build links the platform's ICD loader
  (Apple's OpenCL framework here) and the headers come from the vendored
  `include/internal/CL/cl.hpp` listed above.
- **OpenGL and GLFW** — only on builds configured with `-DENABLE_OPENGL=ON`,
  which is the Raspberry Pi capture node rather than the Mac. GLFW
  (<http://www.glfw.org/>) is zlib/libpng licensed, Copyright (C) 2002-2006
  Marcus Geelnard and (C) 2006-2013 Camilla Berglund. Installed as a system
  package.
