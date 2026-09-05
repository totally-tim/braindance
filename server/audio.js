import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { validAudioHash, AUDIO_RATE, AUDIO_SECONDS, AUDIO_UPLOAD_BYTES, readAudioWav } from '../web/audio-source.js';

const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export class AudioStore {
  constructor(root) { this.root = root; this.importing = false; this.writes = 0; }

  async read(hash) {
    if (!validAudioHash(hash)) throw new Error('invalid audio content hash');
    const file = await open(join(this.root, `${hash.slice(7)}.wav`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > AUDIO_SECONDS * AUDIO_RATE * 4 + 4096) throw new Error('audio asset is not a bounded WAV file');
      const bytes = await file.readFile();
      if (digest(bytes) !== hash) throw new Error('audio asset content does not match its hash');
      return bytes;
    } finally { await file.close(); }
  }

  async import(stream) {
    if (this.importing) throw new Error('another audio import is running');
    this.importing = true;
    let scratch = null;
    try {
      await mkdir(this.root, { recursive: true });
      scratch = await mkdtemp(join(this.root, '.import-'));
      const input = join(scratch, 'input');
      const file = await open(input, 'wx');
      let size = 0;
      try {
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > AUDIO_UPLOAD_BYTES) throw new Error(`audio import exceeds ${AUDIO_UPLOAD_BYTES} bytes`);
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      if (!size) throw new Error('audio file is empty');
      const output = join(scratch, 'audio.wav');
      await new Promise((resolve, reject) => {
        const child = spawn(FFMPEG, [
          '-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0',
          '-map', '0:a:0', '-vn', '-t', String(AUDIO_SECONDS + 0.01), '-ac', '2', '-ar', String(AUDIO_RATE),
          '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', output,
        ], { stdio: ['pipe', 'ignore', 'pipe'] });
        let error = '';
        const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
        child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-2000); });
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`audio could not be decoded: ${error.trim() || 'decoder stopped or timed out'}`));
        });
        pipeline(createReadStream(input), child.stdin).catch(() => { /* Decoder refusal is reported on close. */ });
      });
      const bytes = await readFile(output);
      const { duration } = readAudioWav(bytes);
      const hash = digest(bytes);
      try {
        // Publish the complete file atomically; a failed write must not occupy its content hash.
        await link(output, join(this.root, `${hash.slice(7)}.wav`));
        this.writes++;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        await this.read(hash);
      }
      return { hash, duration };
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      this.importing = false;
    }
  }
}

// Silence is generated as a stream, so a clip placed hours into the edit needs no delay buffer.
export function audioFilter(clip, from, frames, fps) {
  const count = Math.round(frames * AUDIO_RATE / fps);
  const outputStart = Math.round(from * AUDIO_RATE);
  const sourceStart = Math.round(clip.start * AUDIO_RATE);
  const sourceEnd = sourceStart + Math.round(clip.duration * AUDIO_RATE);
  const begin = Math.max(outputStart, sourceStart);
  const end = Math.min(outputStart + count, sourceEnd);
  const silence = (n, name) => `anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${n}[${name}]`;
  if (end <= begin) return `${silence(count, 'audio')}`;
  const filters = [];
  const parts = [];
  if (begin > outputStart) { filters.push(silence(begin - outputStart, 'lead')); parts.push('[lead]'); }
  filters.push(`[1:a]atrim=start_sample=${begin - sourceStart}:end_sample=${end - sourceStart},asetpts=PTS-STARTPTS[body]`);
  parts.push('[body]');
  if (end < outputStart + count) { filters.push(silence(outputStart + count - end, 'tail')); parts.push('[tail]'); }
  filters.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1[audio]`);
  return filters.join(';');
}
