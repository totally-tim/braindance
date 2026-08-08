// The webcam output: the colour camera's own picture, served as MJPEG over HTTP so
// OBS can open it as a source URL.
//
// **This is a different picture from the one the point cloud is textured with, and
// that is the whole reason this file exists.** A type 2 frame carries the *registered*
// colour - `Registration::apply`'s resample of the colour camera into the depth
// camera's viewpoint. It wears the depth camera's 70.6 degree frustum instead of the
// colour camera's 84.1, and it is punched through with holes wherever the depth solve
// returned nothing for a ray to carry colour on. Shading a cloud with it is exactly
// right; handing it to somebody's video call is a 512x424 picture that speckles black
// whenever depth drops out. So the grabber encodes the native 1920x1080 frame as a
// second stream, and this serves those bytes through untouched.
//
// **Untouched is load-bearing rather than lazy.** Nothing here decodes, scales,
// mirrors or crops, so the endpoint has no picture pipeline in it and cannot grow one
// by accident. Whether it ever should is an open question with an issue on it (#16);
// until that is answered the boundary is that a processed webcam is a renderer job,
// because the renderer is the one image pipeline this program already has and a
// second one beside it is the drift the whole design rejects.
//
// **Availability is the property this is built around.** A webcam has to survive an
// hour-long call with the Braindance UI closed and the window minimised, which is why
// the bytes come straight off the server rather than through the browser: routing
// them through a page would mean a JPEG decode, a canvas draw and a readback on a
// machine that already had the bytes, and would make the picture's existence
// contingent on a foreground GPU tab that the browser is entitled to throttle.

// One boundary token for the life of the process. It appears in the response header
// and between every part, and the two have to agree or the stream does not parse.
const BOUNDARY = 'braindanceframe';

/**
 * How long the colour stream stays running after the last subscriber leaves.
 *
 * **OBS retries a dead source hard**, and a browser source or a media source that
 * reconnects every second would otherwise toggle the grabber's encoder on and off at
 * the same rate - each toggle crossing a pipe into another process, and each one
 * arriving as a gap in somebody's picture. Holding the stream open for a few seconds
 * turns a reconnect into a seamless resume, and costs nothing but a few frames of
 * encode on a thread that is otherwise idle.
 */
const LINGER_MS = 6000;

/**
 * How many frames a single subscriber may be behind before frames start being
 * dropped for it.
 *
 * One, which is to say drop-to-latest. **MJPEG over HTTP has no divisor and no stride
 * to negotiate**, unlike the WebSocket monitors, so this is the only backpressure
 * control the webcam has. A subscriber on a link that cannot carry the stream must
 * fall behind by dropping frames rather than by queueing them: the queue would grow
 * in this process, and its memory is the least of it - the socket that never drains
 * is what pushes back through the grabber's pipe and makes it miss USB deadlines,
 * which costs the take frames that no amount of downloading recovers.
 */
const MAX_IN_FLIGHT = 1;

export class Webcam {
  /**
   * @param {object} opts
   * @param {(wanted: boolean) => void} opts.request  asks the grabber to start or
   *   stop encoding. Called only on a change, and re-called by `reassert` after a
   *   grabber restart, because the new process starts with its encoder off and has
   *   never heard of the subscriber that is still attached.
   */
  constructor({ request }) {
    this.request = request;
    this.subscribers = new Set();
    this.latest = null;
    this.latestAt = 0;
    this.wanted = false;
    this.lingerTimer = null;
    // Why the picture is not available, or null when it is. Held as a sentence
    // rather than a flag because it is served to whoever asked: a webcam that
    // answers an empty stream is one somebody debugs for twenty minutes, and a
    // webcam that answers "colour is off on this grabber" is one they fix.
    //
    // **This asks whether there is a colour camera to serve, never whether a frame
    // has arrived yet**, and the difference is not academic - it was a deadlock. The
    // grabber encodes only while somebody is subscribed, so "no frame yet" as a
    // reason to refuse means the first subscriber is turned away, the encoder is
    // never asked to start, and the endpoint 503s for the life of the process while
    // every part of it reports healthy. Waiting for the first frame is the ordinary
    // way to arrive here; a subscriber attaches, the request goes down to the
    // grabber, and the picture paints when it comes.
    //
    // So there is exactly one thing that clears this - a hello from a grabber with
    // colour on - and several that set it. Revocations are idempotent and cannot
    // drift into wrongly-available, which is the direction that would matter.
    this.unavailable = 'no sensor has handshaken with this server yet';
    this.served = 0;
    this.dropped = 0;
  }

  /** Whether a subscriber's frames leave this machine. */
  static isLoopback(req) {
    const a = req.socket.remoteAddress ?? '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  /**
   * Drop any subscriber whose response has already gone, and settle if that changed
   * anything.
   *
   * `res.on('close')` is what normally removes one, and this asks the same question of
   * the resource rather than of the bookkeeping that claims to track it. The direction
   * that matters is the one where the set outlives the socket: the operator reads this
   * count as "something is watching", and the recorder charges a take for every entry
   * in it, so a subscriber the wire no longer has is a lit dot and a refusal nobody can
   * account for. Where the event does fire this is a no-op, which is the point - it is
   * the floor under the bookkeeping and not a second copy of it.
   */
  #reap() {
    let went = false;
    for (const s of this.subscribers) {
      if (s.res.destroyed || s.res.writableEnded) {
        this.subscribers.delete(s);
        went = true;
      }
    }
    if (went) this.#settle();
  }

  get count() {
    this.#reap();
    return this.subscribers.size;
  }

  /**
   * Every attached subscriber, and whether its frames cross a network.
   *
   * Read by `/record/state` so the recorder's refusal can name what a take would be
   * paying for. The webcam has to be in that accounting by *existing* rather than by
   * somebody having remembered to add it - a cost the refusal cannot see is a cost it
   * silently under-reports, and the whole point of the refusal is that the number is
   * true.
   */
  describe() {
    this.#reap();
    return [...this.subscribers].map((s) => ({ loopback: s.loopback, behind: s.behind }));
  }

  /**
   * The subscribers the take is paying for.
   *
   * **The loopback exemption is inherited by argument here, not by measurement, and
   * that distinction is worth keeping.** The WebSocket monitors' exemption was
   * measured: their cost is backpressure from a link that cannot carry 14.6 MB/s
   * reaching the grabber, and frames that never leave the machine never touch that
   * link. The same reasoning plainly applies to a ~50Mbit/s multipart stream on the
   * same pipe, and the same reasoning is not the same measurement. Nothing here reads
   * as if it had been measured; the interleaved A/B for this stream on a capture node
   * has not been run.
   *
   * **This is the one place that rule is written**, which is what makes the paragraph
   * above worth keeping: the recorder's refusal used to repeat the same test inline,
   * so whoever ran that A/B would have edited the copy carrying the reasoning and
   * found that nothing happened. It returns the subscribers rather than a boolean so
   * the refusal can name one consumer per costing subscriber without knowing what
   * makes one costly.
   *
   * Named for the subscribers rather than for the question, because the name that asks
   * the question outright already belongs to a different rule about a different
   * consumer - the monitors' divisor and stride test in `server/index.js` - and a
   * reader should not have to work out which of the two they are looking at.
   */
  subscribersCostingTheTake() {
    return this.describe().filter((s) => !s.loopback);
  }

  /**
   * A colour frame off the wire. Held, not queued: a subscriber that missed one is
   * not owed it.
   */
  offer(jpeg, timestampMs) {
    this.latest = jpeg;
    this.latestAt = timestampMs;
    for (const s of this.subscribers) this.#push(s);
  }

  /**
   * The picture has stopped being available, with the reason. Called when colour is
   * switched off, when the grabber goes away, and when the sensor state leaves live.
   */
  setUnavailable(reason) {
    this.unavailable = reason;
    // Dropped rather than kept, so a source that reconnects during an outage is not
    // painted a still of the moment the sensor died and left to believe it is live.
    this.latest = null;
  }

  /**
   * A grabber has handshaken and colour is on, so there is a camera to serve.
   *
   * The only thing in this file that clears the reason above, which is what keeps
   * "available" from being reachable by accident from a code path that merely saw
   * some bytes go by.
   */
  setAvailable() {
    this.unavailable = null;
  }

  /**
   * Re-ask the grabber for what the subscribers already wanted.
   *
   * A restarted grabber is a new process with its encoder off, and it has never heard
   * of a subscriber that attached to the old one. Without this the webcam comes back
   * from a colour toggle or a USB drop as a socket that is open, subscribed and
   * permanently silent - the failure mode being that everything looks connected.
   */
  reassert() {
    if (this.wanted) this.request(true);
  }

  /**
   * The MJPEG route.
   *
   * **The origin rule is not applied here**, and deliberately not: it belongs to the
   * dispatcher, which asks it of every route the table marks as serving live sensor
   * bytes. A copy of the rule in this handler would be the second copy, and the next
   * live route somebody adds would be outside it - which is the exact shape of the
   * hole the route table was built to close for mutations.
   */
  attach(req, res) {
    // Answered rather than left hanging. A 503 naming the reason is the difference
    // between somebody fixing a setting and somebody filing a bug about a black
    // rectangle - and it is the honest answer for a colour toggle that just restarted
    // the grabber out from under a live call.
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
      this.#settle();
    };
    res.on('close', drop);
    res.on('error', drop);

    this.#settle();
    // The frame in hand rather than the next one to arrive, so a source that connects
    // between frames paints immediately instead of showing a blank rectangle for up
    // to a colour interval - which in dim light is 66ms and reads as a broken source.
    if (this.latest) this.#push(sub);
  }

  /** Turn the grabber's encoder on or off to match what is attached, with the linger. */
  #settle() {
    const want = this.subscribers.size > 0;
    if (want) {
      if (this.lingerTimer) {
        clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
      }
      if (!this.wanted) {
        this.wanted = true;
        this.request(true);
      }
      return;
    }
    if (!this.wanted || this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      // Re-checked rather than assumed: a subscriber may have arrived while this
      // timer was pending, and turning the stream off under it would be the toggle
      // storm the linger exists to prevent.
      if (this.subscribers.size > 0) return;
      this.wanted = false;
      this.request(false);
    }, LINGER_MS);
  }

  #push(sub) {
    if (!this.latest) return;
    // Drop-to-latest. A subscriber still draining the previous frame is one whose
    // link cannot carry this one, and the frame it is owed is the newest, not this.
    if (sub.inFlight >= MAX_IN_FLIGHT) {
      sub.behind++;
      this.dropped++;
      return;
    }
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.latest.length}\r\n\r\n`,
    );
    sub.inFlight++;
    // One `write` for the whole part rather than three, so a part cannot be
    // interleaved with anything and a slow socket cannot leave a header stranded
    // without its body.
    sub.res.write(Buffer.concat([head, this.latest, Buffer.from('\r\n')]), () => {
      sub.inFlight--;
    });
    this.served++;
  }
}
