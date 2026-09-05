const DISK_BYTES = 2 * 1024 * 1024 * 1024;
const MEMORY_BYTES = 96 * 1024 * 1024;

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  }
  return value;
}

/** Keyed values come from their tracks, not the last frame the editor evaluated. */
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
  return JSON.stringify(ordered(copy));
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
  constructor({ name = 'braindance-previews-v1', limit = DISK_BYTES } = {}) {
    this.limit = limit;
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
      const tx = db.transaction(['frames', 'entries'], 'readwrite');
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
      const tx = db.transaction(['frames', 'entries', 'size'], 'readwrite');
      const frames = tx.objectStore('frames');
      const entries = tx.objectStore('entries');
      const size = tx.objectStore('size');
      const key = [signature, frame];
      const removed = [];
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
          let total = (totalRequest.result ?? 0) - (previous.result?.bytes ?? 0) + bytes;
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
        resolve({ removed, bytes });
      };
      tx.onabort = () => reject(problem ?? tx.error ?? new Error('Preview storage is full or unavailable.'));
    });
  }

  async remove(signature, frame) {
    const db = await this.open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['frames', 'entries', 'size'], 'readwrite');
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
      const tx = db.transaction(['frames', 'entries', 'size'], 'readwrite');
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
