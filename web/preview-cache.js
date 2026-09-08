const DISK_BYTES = 2 * 1024 * 1024 * 1024;
const MEMORY_BYTES = 96 * 1024 * 1024;
// Previews are a disposable cache, so a write may skip the fsync a document store would need.
const RELAXED = { durability: 'relaxed' };

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string as 64 hex characters; synchronous, and present on plain-HTTP origins. */
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(bytes.length) * 8n);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const view = new DataView(padded.buffer);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((n) => n.toString(16).padStart(8, '0')).join('');
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  }
  return value;
}

/**
 * The key one rendered edit is stored under: a digest of the canonical document and view.
 * Keyed values come from their tracks, not the last frame the editor evaluated.
 */
export function previewIdentity(snapshot) {
  const copy = structuredClone(snapshot);
  for (const block of [copy.project.look, ...copy.project.clips]) {
    for (const [name, keys] of Object.entries(block.tracks ?? {})) {
      if (keys.length && Object.hasOwn(block.params ?? {}, name)) block.params[name] = keys[0].value;
    }
  }
  for (const clip of copy.project.clips) {
    delete clip.appliedPreset;
    if (clip.take) delete clip.take.id;
  }
  return sha256Hex(JSON.stringify(ordered(copy)));
}

export function previewRanges(frames) {
  const ranges = [];
  for (const frame of [...frames].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && frame <= last[1] + 1) last[1] = Math.max(last[1], frame);
    else ranges.push([frame, frame]);
  }
  return ranges;
}

/** Owns decoded images and closes each one on replacement or eviction. */
export class PreviewImages {
  constructor(limit = MEMORY_BYTES) {
    this.limit = limit;
    this.bytes = 0;
    this.images = new Map();
  }

  get(frame) {
    const held = this.images.get(frame);
    if (!held) return null;
    this.images.delete(frame);
    this.images.set(frame, held);
    return held;
  }

  put(frame, image, plans) {
    const bytes = image.width * image.height * 4
      + Object.values(plans ?? {}).reduce((n, depth) => n + depth.byteLength, 0);
    this.delete(frame);
    if (bytes > this.limit) { image.close(); return false; }
    while (this.bytes + bytes > this.limit) this.delete(this.images.keys().next().value);
    this.images.set(frame, { image, plans, bytes });
    this.bytes += bytes;
    return true;
  }

  delete(frame) {
    const held = this.images.get(frame);
    if (!held) return;
    this.bytes -= held.bytes;
    held.image.close();
    this.images.delete(frame);
  }

  clear() { for (const frame of this.images.keys()) this.delete(frame); }
}

/** Compressed frames live in this browser profile; transactions enforce the shared limit. */
export class PreviewStore {
  constructor({ name = 'braindance-previews-v2', limit = DISK_BYTES } = {}) {
    this.limit = limit;
    // Earlier stores keyed frames by the whole document; nothing reads them, so free the disk.
    try { indexedDB.deleteDatabase('braindance-previews-v1'); } catch { /* No storage here. */ }
    this.listeners = new Set();
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = ({ data }) => {
      for (const listener of this.listeners) listener(data);
    };
    this.open = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const frames = db.createObjectStore('frames', { keyPath: ['signature', 'frame'] });
        frames.createIndex('signature', 'signature');
        const entries = db.createObjectStore('entries', { keyPath: ['signature', 'frame'] });
        entries.createIndex('used', 'used');
        entries.createIndex('signature', 'signature');
        db.createObjectStore('size');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Preview storage is open in an older tab. Close that tab and reload.'));
    });
    this.open.catch(() => {});
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status(signature) {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['entries', 'size']);
      const frames = signature === null ? null : tx.objectStore('entries').index('signature').getAllKeys(signature);
      const bytes = tx.objectStore('size').get('bytes');
      const epoch = tx.objectStore('size').get('epoch');
      tx.oncomplete = () => resolve({
        frames: new Set(frames?.result.map((key) => key[1]) ?? []), bytes: bytes.result ?? 0, epoch: epoch.result ?? 0,
      });
      tx.onabort = () => reject(tx.error);
    });
  }

  async read(signature, frame) {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['frames', 'entries'], 'readwrite', RELAXED);
      const request = tx.objectStore('frames').get([signature, frame]);
      let value = null;
      request.onsuccess = () => {
        value = request.result ?? null;
        if (value) tx.objectStore('entries').put({
          signature, frame, bytes: value.bytes, used: Date.now(),
        });
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error('Preview read was interrupted.'));
    });
  }

  async frames(signature) {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('entries');
      const request = tx.objectStore('entries').index('signature').getAllKeys(signature);
      tx.oncomplete = () => resolve(new Set(request.result.map((key) => key[1])));
      tx.onabort = () => reject(tx.error);
    });
  }

  async put(signature, frame, blob, plans = {}, epoch = null) {
    if (!(blob instanceof Blob) || !blob.size || !Number.isSafeInteger(frame) || frame < 0) {
      throw new Error('A preview must contain an encoded image and an output frame number.');
    }
    const bytes = blob.size + signature.length * 4 + 256
      + Object.values(plans).reduce((n, depth) => n + depth.byteLength, 0);
    if (bytes > this.limit) throw new Error('One preview frame exceeds the cache limit.');
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['frames', 'entries', 'size'], 'readwrite', RELAXED);
      const frames = tx.objectStore('frames');
      const entries = tx.objectStore('entries');
      const size = tx.objectStore('size');
      const key = [signature, frame];
      const removed = [];
      let total = 0;
      let problem = null;
      const epochRequest = size.get('epoch');
      epochRequest.onsuccess = () => {
        if (epoch !== null && epoch !== (epochRequest.result ?? 0)) {
          problem = new DOMException('Preview storage was cleared during rendering.', 'AbortError');
          tx.abort();
        }
      };
      const totalRequest = size.get('bytes');
      totalRequest.onsuccess = () => {
        const previous = entries.get(key);
        previous.onsuccess = () => {
          total = (totalRequest.result ?? 0) - (previous.result?.bytes ?? 0) + bytes;
          frames.put({ signature, frame, blob, plans, bytes });
          entries.put({ signature, frame, bytes, used: Date.now() });
          const cursor = entries.index('used').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (total <= this.limit || !row) { size.put(total, 'bytes'); return; }
            const entry = row.value;
            if (entry.signature !== signature || entry.frame !== frame) {
              total -= entry.bytes;
              frames.delete(row.primaryKey);
              row.delete();
              removed.push([entry.signature, entry.frame]);
            }
            row.continue();
          };
        };
      };
      tx.oncomplete = () => {
        this.channel?.postMessage({ changed: signature, removed });
        resolve({ removed, bytes, total });
      };
      tx.onabort = () => reject(problem ?? tx.error ?? new Error('Preview storage is full or unavailable.'));
    });
  }

  async remove(signature, frame) {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['frames', 'entries', 'size'], 'readwrite', RELAXED);
      const key = [signature, frame];
      const entry = tx.objectStore('entries').get(key);
      entry.onsuccess = () => {
        if (!entry.result) return;
        const size = tx.objectStore('size');
        const total = size.get('bytes');
        total.onsuccess = () => size.put(Math.max(0, (total.result ?? 0) - entry.result.bytes), 'bytes');
        tx.objectStore('frames').delete(key);
        tx.objectStore('entries').delete(key);
      };
      tx.oncomplete = () => {
        this.channel?.postMessage({ removed: [[signature, frame]] });
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    });
  }

  async clear() {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['frames', 'entries', 'size'], 'readwrite', RELAXED);
      const size = tx.objectStore('size');
      const epoch = size.get('epoch');
      epoch.onsuccess = () => {
        tx.objectStore('frames').clear();
        tx.objectStore('entries').clear();
        size.put(0, 'bytes');
        size.put((epoch.result ?? 0) + 1, 'epoch');
      };
      tx.oncomplete = () => {
        this.channel?.postMessage({ cleared: true });
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    });
  }

  async usage() {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('size');
      const request = tx.objectStore('size').get('bytes');
      tx.oncomplete = () => resolve({ bytes: request.result ?? 0, limit: this.limit });
      tx.onabort = () => reject(tx.error);
    });
  }

  async close() {
    this.channel.close();
    this.channel = null;
    this.listeners.clear();
    (await this.open).close();
  }
}
