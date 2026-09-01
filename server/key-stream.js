// The keyed colour output: each depth picture off the grabber goes out with the colour frame it
// belongs to, over the WebSocket every client is already on. Nothing here reaches the recorder -
// a capture is the wire verbatim, so a key message in one would move every take's content hash.
//
// The colour comes from the webcam rather than from a second decode: `key on` implies the colour
// encode, so the frame this pairs with is the one the webcam is already holding.

import { decodeKeyPayload, encodePair } from '../web/key-stream.js';
import { OnDemand } from './on-demand.js';

export class KeyStream {
  // `maxBuffered` is handed in rather than declared here, so the ceiling a key client is dropped at
  // is the same number `broadcastFrame` drops a monitor at.
  constructor({ request, webcam, maxBuffered }) {
    this.webcam = webcam;
    this.maxBuffered = maxBuffered;
    // Per socket, because the colour elision is: two clients that joined a frame apart are owed
    // different bytes for the same pair.
    this.clients = new Map();
    this.demand = new OnDemand({ request, count: () => this.clients.size });
    // Why there is no keyed picture, or null when there is. The same question the webcam asks: is
    // there a colour camera, never has a frame arrived.
    this.unavailable = 'no sensor has handshaken with this server yet';
    this.served = 0;
    this.dropped = 0;
    // Depth pictures thrown away because no colour frame had arrived to pair them with. A key
    // client that sees nothing needs to be able to tell this from nothing arriving at all.
    this.withoutColour = 0;
  }

  get count() {
    this.#reap();
    return this.clients.size;
  }

  // Every attached client, and whether its pairs cross a network. Read by `/record/state`.
  describe() {
    this.#reap();
    return [...this.clients.values()].map((c) => ({ loopback: c.loopback, behind: c.behind }));
  }

  // The clients the take is paying for, on the webcam's rule: a pair leaving the machine is
  // backpressure the grabber feels, and one staying on it is not.
  subscribersCostingTheTake() {
    return this.describe().filter((c) => !c.loopback);
  }

  attach(ws, loopback) {
    // A second `{ key: true }` on one socket must not reset the elision, or the client is sent a
    // colour frame it already has.
    if (this.clients.has(ws)) return;
    this.clients.set(ws, { loopback, behind: 0, lastColourTs: null });
    this.demand.settle();
    console.log(`[key] client attached (${this.clients.size} total, ${loopback ? 'loopback' : 'remote'})`);
  }

  detach(ws) {
    if (!this.clients.delete(ws)) return;
    console.log(`[key] client gone (${this.clients.size} left)`);
    this.demand.settle();
  }

  /** One type 4 payload off the wire, paired with the colour frame the webcam is holding. */
  offer(payload) {
    this.#reap();
    if (this.clients.size === 0) return;
    const colour = this.webcam.latest;
    if (!colour) {
      this.withoutColour++;
      return;
    }
    const colourTs = this.webcam.latestAt;

    let key;
    try {
      key = decodeKeyPayload(payload);
    } catch (err) {
      console.error(`[key] ${err.message}`);
      return;
    }

    // At most two buffers per pair rather than one per client: the elided form is the same bytes
    // for every socket that already holds this colour frame.
    let whole = null;
    let elided = null;
    for (const [ws, c] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // Drop-to-latest, the same ceiling a monitor is dropped at: a client that cannot keep up is
      // owed the next pair, and a queue here pushes back through the grabber's pipe.
      if (ws.bufferedAmount > this.maxBuffered) {
        c.behind++;
        this.dropped++;
        continue;
      }
      const pair = { depthTs: key.ts, colourTs, fx: key.fx, fy: key.fy, cx: key.cx, cy: key.cy, rangeM: key.rangeM };
      let out;
      if (c.lastColourTs === colourTs) {
        elided ??= encodePair({ ...pair, colour: null, depth: key.jpeg });
        out = elided;
      } else {
        whole ??= encodePair({ ...pair, colour, depth: key.jpeg });
        out = whole;
      }
      ws.send(out);
      c.lastColourTs = colourTs;
      this.served++;
    }
  }

  setUnavailable(reason) {
    this.unavailable = reason;
    // The colour frames restart with the grabber that sends them, and their stamps restart with it
    // too. A `lastColourTs` carried across that seam could match a new frame and elide it, leaving
    // the page keying live depth against a picture from before the outage.
    for (const c of this.clients.values()) c.lastColourTs = null;
  }

  setAvailable() {
    this.unavailable = null;
  }

  reassert() {
    this.demand.reassert();
  }

  // Drop any client whose socket has already gone: the take is charged for every entry here, so
  // one the wire no longer has is a refusal nobody can account for.
  #reap() {
    let went = false;
    for (const ws of this.clients.keys()) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) continue;
      this.clients.delete(ws);
      went = true;
    }
    if (went) this.demand.settle();
  }
}
