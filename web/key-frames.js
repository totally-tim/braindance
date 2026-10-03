import { decodePair } from './key-stream.js';

// Own decoded images until the draw finishes, and invalidate work across every outage.
export class KeyFrames {
  constructor({ decode, draw, clear, clock = globalThis }) {
    this.decode = decode;
    this.draw = draw;
    this.clear = clear;
    this.clock = clock;
    this.frames = 0;
    this.errors = 0;
    this.lastDepthTs = 0;
    this.lastColourTs = null;
    this.colour = null;
    this.depth = null;
    this.pending = null;
    this.decoding = false;
    this.generation = 0;
    this.timer = null;
  }

  reset() {
    this.generation++;
    this.pending = null;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.clear();
    this.colour?.close();
    this.depth?.close();
    this.colour = this.depth = null;
    this.lastColourTs = null;
    this.lastDepthTs = 0;
  }

  offer(bytes) {
    let pair;
    try {
      pair = decodePair(bytes);
    } catch {
      this.errors++;
      this.reset();
      return;
    }
    if (this.pending?.colour && !pair.colour && this.pending.colourTs === pair.colourTs) {
      pair.colour = this.pending.colour;
    }
    this.pending = pair;
    this.#pump();
  }

  async #pump() {
    if (this.decoding || !this.pending) return;
    this.decoding = true;
    const pair = this.pending;
    const generation = this.generation;
    this.pending = null;
    let colour = null, depth = null;
    try {
      [colour, depth] = await Promise.all([
        pair.colour ? this.decode(pair.colour) : null,
        this.decode(pair.depth),
      ]);
      if (generation !== this.generation) {
        colour?.close();
        depth?.close();
        return;
      }
      if (!depth || (pair.colour && !colour)
          || (!colour && (!this.colour || this.lastColourTs !== pair.colourTs))) {
        colour?.close();
        depth?.close();
        this.errors++;
        this.reset();
        return;
      }
      const oldColour = this.colour, oldDepth = this.depth;
      const newColour = this.lastColourTs !== pair.colourTs;
      this.colour = colour ?? oldColour;
      this.depth = depth;
      this.lastColourTs = pair.colourTs;
      this.lastDepthTs = pair.depthTs;
      try {
        this.draw(pair, colour, depth);
      } finally {
        if (colour) oldColour?.close();
        oldDepth?.close();
      }
      this.frames++;
      if (newColour) {
        this.clock.clearTimeout(this.timer);
        this.timer = this.clock.setTimeout(() => this.reset(), 1000);
      }
    } catch {
      colour?.close();
      depth?.close();
      if (generation === this.generation) {
        this.errors++;
        this.reset();
      }
    } finally {
      this.decoding = false;
      if (this.pending) this.#pump();
    }
  }
}
