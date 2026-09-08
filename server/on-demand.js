// Whether the grabber is being asked to produce a stream, for the two streams it produces on
// demand: the colour camera the webcam serves, and the keyed depth the /key page reads. One class
// rather than a copy in each, because the linger and the reassert are the parts that drift.

// How long a stream stays up after the last subscriber leaves. OBS retries a dead source hard, and
// without the linger every reconnect toggles the grabber's encoder.
export const LINGER_MS = 6000;

export class OnDemand {
  // `request` asks the grabber to start or stop producing, and is called only on a change. `count`
  // is asked rather than held, so the stream keeps one answer to how many subscribers it has.
  constructor({ request, count }) {
    this.request = request;
    this.count = count;
    this.wanted = false;
    this.lingerTimer = null;
  }

  /** Turn the grabber's encoder on or off to match what is attached, with the linger. */
  settle() {
    if (this.count() > 0) {
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
      // Re-checked: a subscriber may have arrived while this timer was pending.
      if (this.count() > 0) return;
      this.wanted = false;
      this.request(false);
    }, LINGER_MS);
  }

  // Re-ask the grabber for what the subscribers already wanted: a restarted grabber has its encoder
  // off and has never heard of a subscriber that attached to the old one.
  reassert() {
    if (this.wanted) this.request(true);
  }
}
