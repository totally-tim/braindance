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

// Only the server's bounded PCM WAV is read here; compressed files go through the import door.
export function readAudioWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (bytes.length < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE'
    || v.getUint32(4, true) + 8 !== bytes.length) throw new Error('audio is not a complete PCM WAV');
  let channels = 0;
  let data = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const n = v.getUint32(at + 4, true);
    if (at + 8 + n > bytes.length) throw new Error('audio WAV has a truncated chunk');
    if (text(at, 4) === 'fmt ') {
      if (n < 16 || v.getUint16(at + 8, true) !== 1 || v.getUint32(at + 12, true) !== AUDIO_RATE
        || v.getUint16(at + 22, true) !== 16) throw new Error('audio must be 48 kHz, 16-bit PCM');
      channels = v.getUint16(at + 10, true);
      if (![1, 2].includes(channels) || v.getUint16(at + 20, true) !== channels * 2) throw new Error('audio must be mono or stereo');
    }
    if (text(at, 4) === 'data') data = { at: at + 8, n };
    at += 8 + n + (n % 2);
  }
  if (!channels || !data || !data.n || data.n % (channels * 2)) throw new Error('audio WAV has no complete samples');
  const frames = data.n / (channels * 2);
  if (frames > AUDIO_SECONDS * AUDIO_RATE) throw new Error(`audio is longer than ${AUDIO_SECONDS} seconds`);
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) samples[c][i] = v.getInt16(data.at + (i * channels + c) * 2, true) / 32768;
  }
  return { samples, duration: frames / AUDIO_RATE, rate: AUDIO_RATE };
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
  const gains = [s.low, s.mid, s.high].map((db) => 10 ** (db / 20));
  for (const channel of pcm.samples) {
    let low = 0;
    let belowHigh = 0;
    for (let i = 0; i < frames; i++) {
      const sample = channel[i];
      low += lowK * (sample - low);
      belowHigh += midK * (sample - belowHigh);
      const filtered = low * gains[0] + (belowHigh - low) * gains[1] + (sample - belowHigh) * gains[2];
      energy[Math.floor(i / hop)] += filtered * filtered;
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

// The display windows the input and filtered samples at the playhead, including while paused.
export function audioSpectrum(pcm, second, settings) {
  const n = 2048;
  const powers = [new Float64Array(n / 2), new Float64Array(n / 2)];
  const end = Math.floor(second * AUDIO_RATE);
  const lowK = 1 - Math.exp(-2 * Math.PI * 200 / AUDIO_RATE);
  const midK = 1 - Math.exp(-2 * Math.PI * 2000 / AUDIO_RATE);
  const gains = [settings.low, settings.mid, settings.high].map((db) => 10 ** (db / 20));
  const gain = 10 ** (settings.gain / 20);
  for (const channel of pcm.samples) {
    const windows = [new Float64Array(n), new Float64Array(n)];
    let low = 0; let belowHigh = 0;
    // This lead-in settles the slowest filter below floating-point precision.
    for (let i = -n; i < n; i++) {
      const sample = second < 0 || second >= pcm.duration ? 0 : (channel[end - n + i] ?? 0);
      low += lowK * (sample - low);
      belowHigh += midK * (sample - belowHigh);
      if (i < 0) continue;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
      windows[0][i] = sample * window;
      windows[1][i] = (low * gains[0] + (belowHigh - low) * gains[1] + (sample - belowHigh) * gains[2]) * gain * window;
    }
    for (const [band, re] of windows.entries()) {
      const im = new Float64Array(n);
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) [re[i], re[j]] = [re[j], re[i]];
      }
      for (let size = 2; size <= n; size *= 2) {
        for (let at = 0; at < n; at += size) {
          for (let j = 0; j < size / 2; j++) {
            const angle = -2 * Math.PI * j / size;
            const x = at + j; const y = x + size / 2;
            const a = re[y] * Math.cos(angle) - im[y] * Math.sin(angle);
            const b = re[y] * Math.sin(angle) + im[y] * Math.cos(angle);
            re[y] = re[x] - a; im[y] = im[x] - b;
            re[x] += a; im[x] += b;
          }
        }
      }
      for (let i = 1; i < powers[band].length; i++) powers[band][i] += (re[i] ** 2 + im[i] ** 2) * (4 / n) ** 2 / pcm.samples.length;
    }
  }
  return Array.from({ length: 64 }, (_, i) => {
    const lo = 20 * 1000 ** (i / 64); const hi = 20 * 1000 ** ((i + 1) / 64);
    const levels = powers.map((bins) => {
      let power = 0;
      for (let k = Math.max(1, Math.floor(lo * n / AUDIO_RATE)); k <= Math.min(bins.length - 1, Math.ceil(hi * n / AUDIO_RATE)); k++) power = Math.max(power, bins[k]);
      return Math.max(-120, 10 * Math.log10(Math.max(1e-12, power)));
    });
    return { hz: Math.sqrt(lo * hi), input: levels[0], output: levels[1] };
  });
}
