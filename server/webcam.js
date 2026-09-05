// The colour camera's own 1920x1080 picture, served as MJPEG so OBS can open it as a source
// URL. A type 2 frame carries the registered colour instead; nothing here decodes or crops.

import { OnDemand } from './on-demand.js';

// Appears in the response header and between every part, and the two have to agree.
const BOUNDARY = 'braindanceframe';

// Drop-to-latest. MJPEG has no divisor or stride to negotiate, so this is the webcam's only
// backpressure control - a queue would push back through the grabber's pipe and cost the take.
const MAX_IN_FLIGHT = 1;

export class Webcam {
  // `request` asks the grabber to start or stop encoding. Called only on a change, and
  // re-called by `reassert` after a restart, because a new grabber's encoder is off.
  constructor({ request }) {
    this.subscribers = new Set();
    this.latest = null;
    this.latestAt = 0;
    this.demand = new OnDemand({ request, count: () => this.subscribers.size });
    // Why the picture is not available, or null when it is; served to whoever asked. It asks
    // whether there is a colour camera, never whether a frame has arrived - the grabber encodes
    // only while subscribed, so refusing on "no frame yet" deadlocks the first subscriber.
    this.unavailable = 'no sensor has handshaken with this server yet';
    this.served = 0;
    this.dropped = 0;
  }

  static isLoopback(req) {
    const a = req.socket.remoteAddress ?? '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  // Drop any subscriber whose response has already gone: the recorder charges a take for
  // every entry in the set, so one the wire no longer has is a refusal nobody can account for.
  #reap() {
    let went = false;
    for (const s of this.subscribers) {
      if (s.res.destroyed || s.res.writableEnded) {
        this.subscribers.delete(s);
        went = true;
      }
    }
    if (went) this.demand.settle();
  }

  get count() {
    this.#reap();
    return this.subscribers.size;
  }

  // Every attached subscriber, and whether its frames cross a network. Read by `/record/state`.
  describe() {
    this.#reap();
    return [...this.subscribers].map((s) => ({ loopback: s.loopback, behind: s.behind }));
  }

  // The subscribers the take is paying for. The loopback exemption is inherited by argument
  // from the WebSocket monitors rather than measured for this stream.
  subscribersCostingTheTake() {
    return this.describe().filter((s) => !s.loopback);
  }

  /** A colour frame off the wire. Held, not queued: a subscriber that missed one is not owed it. */
  offer(jpeg, timestampMs) {
    this.latest = jpeg;
    this.latestAt = timestampMs;
    for (const s of this.subscribers) this.#push(s);
  }

  setUnavailable(reason) {
    this.unavailable = reason;
    // Dropped, so a source reconnecting during an outage is not painted a still of a dead sensor.
    this.latest = null;
  }

  setAvailable() {
    this.unavailable = null;
  }

  reassert() {
    this.demand.reassert();
  }

  // The MJPEG route. The origin rule belongs to the dispatcher, which asks it of every route
  // the table marks as serving live sensor bytes; a copy here would be the second copy.
  attach(req, res) {
    if (this.unavailable) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: this.unavailable }));
      return;
    }

    const sub = { res, loopback: Webcam.isLoopback(req), inFlight: 0, behind: 0 };
    this.subscribers.add(sub);
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Connection': 'close',
    });
    console.log(`[webcam] subscriber attached (${this.subscribers.size} total, ${sub.loopback ? 'loopback' : 'remote'})`);

    const drop = () => {
      if (!this.subscribers.delete(sub)) return;
      console.log(`[webcam] subscriber gone (${this.subscribers.size} left)`);
      this.demand.settle();
    };
    res.on('close', drop);
    res.on('error', drop);

    this.demand.settle();
    // The frame in hand rather than the next one, so a source connecting between frames paints now.
    if (this.latest) this.#push(sub);
  }

  #push(sub) {
    if (!this.latest) return;
    // Drop-to-latest: a subscriber still draining the previous frame is owed the newest, not this.
    if (sub.inFlight >= MAX_IN_FLIGHT) {
      sub.behind++;
      this.dropped++;
      return;
    }
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.latest.length}\r\n\r\n`,
    );
    sub.inFlight++;
    // One write for the whole part, so a slow socket cannot leave a header without its body.
    sub.res.write(Buffer.concat([head, this.latest, Buffer.from('\r\n')]), () => {
      sub.inFlight--;
    });
    this.served++;
  }
}
