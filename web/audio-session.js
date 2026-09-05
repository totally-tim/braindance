import { AUDIO_RATE, analyseAudio, audioSpectrum, readAudioWav, signalAt } from './audio-source.js';

export function createAudioSession({ changed = () => {}, failed = () => {} } = {}) {
  const curves = new Map();
  let decoded = null;
  let context = null;
  let buffer = null;
  let playing = null;
  let spectrum = null;
  let inspection = null;
  let inspectionFailure = null;
  const key = (clip) => JSON.stringify([clip.hash, clip.duration, clip.conditioning]);
  const stop = () => {
    if (playing) { playing.node.stop(); playing.node.disconnect(); playing = null; }
  };
  const pcmFor = async (clip) => {
    if (decoded?.hash === clip.hash) {
      if (Math.abs(decoded.pcm.duration - clip.duration) > 0.5 / AUDIO_RATE) throw new Error('audio duration does not match its saved asset');
      return decoded.pcm;
    }
    const response = await fetch(`/audio/${clip.hash.slice(7)}`);
    if (!response.ok) throw new Error(`audio ${clip.name} is unavailable (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hash !== clip.hash) throw new Error(`audio ${clip.name} does not match its saved content hash`);
    const pcm = readAudioWav(bytes);
    if (Math.abs(pcm.duration - clip.duration) > 0.5 / AUDIO_RATE) throw new Error('audio duration does not match its saved asset');
    decoded = { hash, pcm };
    return pcm;
  };
  const prepare = async (clip) => {
    if (!clip) return;
    inspectionFailure = null;
    const pcm = await pcmFor(clip);
    if (curves.has(key(clip))) return;
    // Let the import status paint before the bounded offline analysis.
    await new Promise((resolve) => setTimeout(resolve, 0));
    curves.set(key(clip), analyseAudio(pcm, clip.conditioning));
  };
  const ready = (clip) => !clip || curves.has(key(clip));
  const value = (clip, t) => clip ? signalAt(curves.get(key(clip)), t - clip.start) : 0;
  const inspect = (clip, t) => {
    if (!clip) return [];
    if (decoded?.hash !== clip.hash) {
      if (!inspection && inspectionFailure !== clip.hash) {
        inspection = pcmFor(clip).then(changed).catch((error) => { inspectionFailure = clip.hash; failed(error); })
          .finally(() => { inspection = null; });
      }
      return [];
    }
    const second = t - clip.start;
    const stamp = `${key(clip)}:${Math.floor(second * 30)}`;
    if (spectrum?.stamp !== stamp) spectrum = { stamp, bins: audioSpectrum(decoded.pcm, second, clip.conditioning) };
    return spectrum.bins;
  };
  const unlock = () => {
    context ??= new AudioContext({ sampleRate: AUDIO_RATE });
    return context.resume();
  };
  const arm = async (clip) => {
    if (!clip) return;
    await unlock();
    const pcm = await pcmFor(clip);
    if (buffer?.hash !== clip.hash) {
      const audio = context.createBuffer(pcm.samples.length, pcm.samples[0].length, AUDIO_RATE);
      pcm.samples.forEach((channel, i) => audio.copyToChannel(channel, i));
      buffer = { hash: clip.hash, audio };
    }
  };
  const sync = (clip, program, running) => {
    const offset = clip ? program - clip.start : -1;
    if (!running || !clip || buffer?.hash !== clip.hash || context?.state !== 'running'
      || offset < 0 || offset >= clip.duration) { stop(); return; }
    const now = context.currentTime;
    if (playing && playing.hash === clip.hash && Math.abs(playing.offset + now - playing.when - offset) <= 0.08) return;
    stop();
    const node = context.createBufferSource();
    node.buffer = buffer.audio;
    node.connect(context.destination);
    node.start(now, offset);
    playing = { node, hash: clip.hash, offset, when: now };
  };
  return { prepare, ready, value, inspect, arm, stop, sync };
}
