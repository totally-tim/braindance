// Audio becomes a sampled control signal before the renderer asks for any program time.
export const AUDIO_RATE = 48000;
export const AUDIO_SECONDS = 600;
export const AUDIO_UPLOAD_BYTES = 64 * 1024 * 1024;
export const validAudioHash = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const FEATURE_RATE = 100;

export function defaultConditioning() {
  return { low: 0, mid: 0, high: 0, gain: 0, floor: -48, ceiling: -6, attack: 10, release: 180 };
}

function bounded(value, lo, hi, name) {
  if (!Number.isFinite(value) || value < lo || value > hi) {
    throw new Error(`audio ${name} must be a number from ${lo} to ${hi}`);
  }
  return value;
}

function checkConditioning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('audio needs conditioning settings');
  const result = {};
  for (const name of ['low', 'mid', 'high']) result[name] = bounded(value[name], -60, 24, name);
  result.gain = bounded(value.gain, -24, 48, 'gain');
  result.floor = bounded(value.floor, -96, -1, 'floor');
  result.ceiling = bounded(value.ceiling, -95, 0, 'ceiling');
  if (result.ceiling <= result.floor) throw new Error('audio ceiling must be above its threshold');
  for (const name of ['attack', 'release']) result[name] = bounded(value[name], 0, 2000, name);
  return result;
}

export function checkAudioClip(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'audio-file') {
    throw new Error('this build reads an audio-file source');
  }
  if (!validAudioHash(value.hash)) throw new Error('audio needs a SHA-256 content hash');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255) throw new Error('audio needs a name of 1 to 255 characters');
  const start = bounded(value.start, 0, 86400, 'start');
  const duration = bounded(value.duration, 1 / AUDIO_RATE, AUDIO_SECONDS, 'duration');
  let target = null;
  if (value.target !== null) {
    const t = value.target;
    if (!t || typeof t !== 'object' || typeof t.param !== 'string' || !/^[a-z][a-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(t.param)
      || (t.clip !== null && (typeof t.clip !== 'string' || !t.clip))) {
      throw new Error('audio target must name an effect parameter and its clip, or null for a project effect');
    }
    target = { param: t.param, clip: t.clip, depth: bounded(t.depth, -1e6, 1e6, 'depth') };
  }
  return { kind: 'audio-file', hash: value.hash, name: value.name, start, duration, conditioning: checkConditioning(value.conditioning), target };
}

const toBytes = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('audio is not a complete PCM WAV');
};

// Only the server's bounded PCM WAV is read here; compressed files go through the import door.
export function readAudioWavHeader(input) {
  const bytes = toBytes(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (bytes.length < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE'
    || v.getUint32(4, true) + 8 !== bytes.length) throw new Error('audio is not a complete PCM WAV');
  let channels = 0;
  let data = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const n = v.getUint32(at + 4, true);
    if (at + 8 + n > bytes.length) throw new Error('audio WAV has a truncated chunk');
    const tag = text(at, 4);
    if (tag === 'fmt ') {
      if (n < 16 || v.getUint16(at + 8, true) !== 1 || v.getUint32(at + 12, true) !== AUDIO_RATE
        || v.getUint16(at + 22, true) !== 16) throw new Error('audio must be 48 kHz, 16-bit PCM');
      channels = v.getUint16(at + 10, true);
      if (![1, 2].includes(channels) || v.getUint16(at + 20, true) !== channels * 2) throw new Error('audio must be mono or stereo');
    } else if (tag === 'data') {
      data = { at: at + 8, n };
    }
    at += 8 + n + (n % 2);
  }
  if (!channels || !data || !data.n || data.n % (channels * 2)) throw new Error('audio WAV has no complete samples');
  const frames = data.n / (channels * 2);
  if (frames > AUDIO_SECONDS * AUDIO_RATE) throw new Error(`audio is longer than ${AUDIO_SECONDS} seconds`);
  return {
    channels,
    rate: AUDIO_RATE,
    samplesPerChannel: frames,
    duration: frames / AUDIO_RATE,
    dataOffset: data.at,
    dataBytes: data.n,
  };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function readAudioWav(input) {
  const bytes = toBytes(input);
  const { channels, samplesPerChannel: frames, duration, rate, dataOffset } = readAudioWavHeader(bytes);
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  const scale = 1 / 32768;
  const byteStart = bytes.byteOffset + dataOffset;
  if (LITTLE_ENDIAN && (byteStart & 1) === 0) {
    const pcm16 = new Int16Array(bytes.buffer, byteStart, frames * channels);
    if (channels === 1) {
      const dst = samples[0];
      for (let i = 0; i < frames; i++) dst[i] = pcm16[i] * scale;
    } else {
      const left = samples[0];
      const right = samples[1];
      for (let i = 0, src = 0; i < frames; i++, src += 2) {
        left[i] = pcm16[src] * scale;
        right[i] = pcm16[src + 1] * scale;
      }
    }
  } else {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) samples[c][i] = v.getInt16(dataOffset + (i * channels + c) * 2, true) * scale;
    }
  }
  return { samples, duration, rate };
}

// Two complementary low-pass splits keep unity EQ equal to the input, including phase.
export function analyseAudio(pcm, settings) {
  const s = checkConditioning(settings);
  const frames = pcm.samples[0].length;
  const hop = AUDIO_RATE / FEATURE_RATE;
  const count = Math.ceil(frames / hop);
  const energy = new Float64Array(count);
  const lowK = 1 - Math.exp(-2 * Math.PI * 200 / AUDIO_RATE);
  const midK = 1 - Math.exp(-2 * Math.PI * 2000 / AUDIO_RATE);
  const g0 = 10 ** (s.low / 20);
  const g1 = 10 ** (s.mid / 20);
  const g2 = 10 ** (s.high / 20);
  for (const channel of pcm.samples) {
    let low = 0;
    let belowHigh = 0;
    for (let block = 0; block < count; block++) {
      const start = block * hop;
      const stop = Math.min(frames, start + hop);
      let sum = 0;
      for (let i = start; i < stop; i++) {
        const sample = channel[i];
        low += lowK * (sample - low);
        belowHigh += midK * (sample - belowHigh);
        const filtered = low * g0 + (belowHigh - low) * g1 + (sample - belowHigh) * g2;
        sum += filtered * filtered;
      }
      energy[block] += sum;
    }
  }
  const values = new Float32Array(count + 1);
  const floor = 10 ** (s.floor / 20);
  const ceiling = 10 ** (s.ceiling / 20);
  const gain = 10 ** (s.gain / 20);
  let envelope = 0;
  for (let i = 0; i < count; i++) {
    const samples = Math.min(hop, frames - i * hop);
    const rms = Math.sqrt(energy[i] / (samples * pcm.samples.length)) * gain;
    const level = Math.min(1, Math.max(0, (rms - floor) / (ceiling - floor)));
    const ms = level > envelope ? s.attack : s.release;
    const keep = ms === 0 ? 0 : Math.exp(-samples / AUDIO_RATE / (ms / 1000));
    envelope = level + keep * (envelope - level);
    values[i + 1] = envelope;
  }
  return { rate: FEATURE_RATE, duration: pcm.duration, values };
}

// A file, a recorded MIDI curve, and a captured live signal can all answer this same question.
export function signalAt(source, second) {
  if (!source || !Number.isFinite(second) || second < 0 || second >= source.duration) return 0;
  const at = second * source.rate;
  const i = Math.floor(at);
  const a = source.values[i] ?? 0;
  return a + ((source.values[i + 1] ?? a) - a) * (at - i);
}

export function modulatedValue(base, depth, signal, min, max) {
  return Math.min(max, Math.max(min, base + depth * signal));
}

const SPEC_N = 2048;
const SPEC_HALF = SPEC_N / 2;
const SPEC_WINDOW = Float64Array.from({ length: SPEC_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / SPEC_N));
const SPEC_BITREV = (() => {
  const rev = new Uint16Array(SPEC_N);
  for (let i = 1, j = 0; i < SPEC_N; i++) {
    let bit = SPEC_N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  return rev;
})();
const SPEC_TWIDDLE_COS = new Float64Array(SPEC_N);
const SPEC_TWIDDLE_SIN = new Float64Array(SPEC_N);
for (let size = 2; size <= SPEC_N; size *= 2) {
  const half = size >> 1;
  for (let j = 0; j < half; j++) {
    const angle = -2 * Math.PI * j / size;
    SPEC_TWIDDLE_COS[half + j] = Math.cos(angle);
    SPEC_TWIDDLE_SIN[half + j] = Math.sin(angle);
  }
}
const SPEC_BANDS = Array.from({ length: 64 }, (_, i) => {
  const lo = 20 * 1000 ** (i / 64);
  const hi = 20 * 1000 ** ((i + 1) / 64);
  return {
    hz: Math.sqrt(lo * hi),
    kLo: Math.max(1, Math.floor(lo * SPEC_N / AUDIO_RATE)),
    kHi: Math.min(SPEC_HALF - 1, Math.ceil(hi * SPEC_N / AUDIO_RATE)),
  };
});
const SPEC_RE0 = new Float64Array(SPEC_N);
const SPEC_RE1 = new Float64Array(SPEC_N);
const SPEC_IM = new Float64Array(SPEC_N);
const SPEC_POW0 = new Float64Array(SPEC_HALF);
const SPEC_POW1 = new Float64Array(SPEC_HALF);

function accumulateSpectrumPowers(re, dst, scale) {
  const im = SPEC_IM;
  im.fill(0);
  for (let i = 1; i < SPEC_N; i++) {
    const j = SPEC_BITREV[i];
    if (i < j) {
      const tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
    }
  }
  for (let size = 2; size <= SPEC_N; size *= 2) {
    const half = size >> 1;
    for (let at = 0; at < SPEC_N; at += size) {
      for (let j = 0; j < half; j++) {
        const c = SPEC_TWIDDLE_COS[half + j];
        const s = SPEC_TWIDDLE_SIN[half + j];
        const x = at + j;
        const y = x + half;
        const ry = re[y];
        const iy = im[y];
        const a = ry * c - iy * s;
        const b = ry * s + iy * c;
        re[y] = re[x] - a;
        im[y] = im[x] - b;
        re[x] += a;
        im[x] += b;
      }
    }
  }
  for (let i = 1; i < SPEC_HALF; i++) {
    const r = re[i];
    const m = im[i];
    dst[i] += (r * r + m * m) * scale;
  }
}

// The display windows the input and filtered samples at the playhead, including while paused.
export function audioSpectrum(pcm, second, settings) {
  const powers0 = SPEC_POW0;
  const powers1 = SPEC_POW1;
  powers0.fill(0);
  powers1.fill(0);
  const inBounds = second >= 0 && second < pcm.duration;
  const rawEnd = Math.floor(second * AUDIO_RATE);
  const lowK = 1 - Math.exp(-2 * Math.PI * 200 / AUDIO_RATE);
  const midK = 1 - Math.exp(-2 * Math.PI * 2000 / AUDIO_RATE);
  const g0 = 10 ** (settings.low / 20);
  const g1 = 10 ** (settings.mid / 20);
  const g2 = 10 ** (settings.high / 20);
  const gain = 10 ** (settings.gain / 20);
  const powerScale = (4 / SPEC_N) ** 2 / pcm.samples.length;
  for (const channel of pcm.samples) {
    const end = inBounds ? Math.max(Math.min(SPEC_N, channel.length), rawEnd) : 0;
    const w0 = SPEC_RE0;
    const w1 = SPEC_RE1;
    let low = 0;
    let belowHigh = 0;
    // This lead-in settles the slowest filter below floating-point precision.
    for (let i = -SPEC_N; i < SPEC_N; i++) {
      const idx = end - SPEC_N + i;
      const sample = !inBounds || idx < 0 || idx >= channel.length ? 0 : channel[idx];
      low += lowK * (sample - low);
      belowHigh += midK * (sample - belowHigh);
      if (i < 0) continue;
      const w = SPEC_WINDOW[i];
      w0[i] = sample * w;
      w1[i] = (low * g0 + (belowHigh - low) * g1 + (sample - belowHigh) * g2) * gain * w;
    }
    accumulateSpectrumPowers(w0, powers0, powerScale);
    accumulateSpectrumPowers(w1, powers1, powerScale);
  }
  return SPEC_BANDS.map(({ hz, kLo, kHi }) => {
    let p0 = 0;
    let p1 = 0;
    for (let k = kLo; k <= kHi; k++) {
      if (powers0[k] > p0) p0 = powers0[k];
      if (powers1[k] > p1) p1 = powers1[k];
    }
    return {
      hz,
      input: Math.max(-120, 10 * Math.log10(Math.max(1e-12, p0))),
      output: Math.max(-120, 10 * Math.log10(Math.max(1e-12, p1))),
    };
  });
}
