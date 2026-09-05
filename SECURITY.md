# Security

Braindance has no authentication. Whoever can reach the port can arm the recorder, start and
stop a take, read the library, and delete footage. There are no accounts, no tokens and no TLS.
It is a tool for driving a sensor on a network you control, and reaching it is the permission.

## What protects you

**The bind address.** The server listens on `127.0.0.1` unless you pass `--host`, so by
default nothing off the machine can reach it. It prints on stdout when you widen the bind.

**The origin rule, which only speaks to browsers.** A request carrying an `Origin` header
must be same-origin, and a mutating HTTP route also requires a matching method and a JSON
content type. A page you merely visit cannot produce those together. A request with no
`Origin` skips the origin check, because every call across the capture-node link is a
server-side `fetch` and Node has no origin to declare. So the rule stops hostile web pages and
nothing else: curl, a script, or another machine on the Wi-Fi sends no `Origin` and is allowed
everything.

**A browser's `Host` must be an IP literal, `localhost` or a `.local` name.** Comparing
`Origin` against `Host` alone does not survive DNS rebinding: a name the attacker controls,
re-resolved onto the address you listen on, makes the two strings equal, and binding to
loopback does not prevent it because the browser doing the connecting is on the machine.
`node tools/guard-check.mjs` proves the rule, and `--mutate host-accepts-a-name` must fail.

A browser sending an `Origin` from any other hostname, such as a reverse proxy, an
`/etc/hosts` entry or a Tailscale MagicDNS name, is refused on every guarded route. Reach the
server by address instead.

## What `--host 0.0.0.0` exposes

Everything, to everyone who can route to the port:

| Route | What it allows |
| --- | --- |
| `POST /record/start`, `/record/stop`, `/record/mark` | arm the node, end a shoot, write marks into a take |
| `GET /library/all`, `GET /capture/:id/file` | list every take and download the footage |
| `POST /library/delete/:id` | destroy a take; its `confirm` flag is a misclick interlock, not an identity check |
| `POST /library/rename/:id` | rename a take; the content hash does not move, so projects still resolve |
| `PUT` and `DELETE` on `/projects/:name`, `/presets/:name`, `/deliverables/:name` | overwrite or delete saved work |
| `POST /jobs` | queue renders without limit on the disk the takes are written to |
| the WebSocket | the live sensor feed and the recorder's controls |
| the `/export` WebSocket | starts an ffmpeg process on the server for each render |
| `GET /camera.mjpg` | the colour camera, live, as an MJPEG stream; opening it starts the encode |
| `GET /key`, and the WebSocket `{key: true}` behind it | the colour camera keyed by depth, and the depth of every colour pixel — a floor plan of the room; opening it starts both encodes |

The origin rule covers `/camera.mjpg` as it covers the mutating routes, and it buys only that
a browser declaring a foreign origin is refused. An `<img>` tag, curl, ffmpeg, VLC and another
machine send no origin and are not stopped. Treat the route as public to the network you bound
to.

`POST /library/reveal/:id` does not widen with the bind. It starts the platform's file
manager on a take's path, and it refuses any caller whose socket is not loopback, read off
`remoteAddress`. The id is held to `VALID_ID`, the path must be a
direct child of the captures directory, the program is a fixed string per platform, and the
arguments are an array with no shell between them. `--reveal-with` substitutes the program for
a proof tool and is never passed on an operator's machine.

## Staying safe

- **Leave the default bind alone on any machine you edit on.** It needs no network access.
- **Pass `--host 0.0.0.0` only on a capture node, on a network you control.** Conference or
  hotel Wi-Fi is not that. A wired link or a dedicated access point between node and editing
  machine is.
- **Put it behind an SSH tunnel or a WireGuard link if it must cross a network you do not
  control**, with the server still bound to loopback on the far side. A tunnelled browser
  counts as local: it gets the uncapped monitor rate and is offered *Show in Finder*, which
  opens a window on the host. Whoever built the tunnel authenticated to the host, so treat
  tunnel access as sitting at the machine.
- **Nothing here is safe to expose to the internet.** Not behind a reverse proxy, not on a
  forwarded port.

## Reporting

Open an issue, or mail <tim@timkraus.eu> for anything you would rather not file in public.
There is no bounty and no SLA. Say whether you found it by reading or by running it.
