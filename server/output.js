import { EXPORT_SIZES } from '../web/export-sizes.js';
import { FRAMING_NAMES } from '../web/crop-box.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const composition = new Set(FRAMING_NAMES);
for (const name of ['camera', 'transform', 'spin', 'renderScale']) composition.add(name);
// Shaped here, not merely counted: this pose goes to every source that connects later, so one
// accepted garbage pose poisons them all. The registry in `web/main.js` still decides whether a
// shape means a drawable camera.
const pose = (v) => object(v) && Array.isArray(v.position) && v.position.length === 3
  && Array.isArray(v.quaternion) && v.quaternion.length === 4 && Number.isFinite(v.fov)
  && [...v.position, ...v.quaternion, v.fov].every(Number.isFinite);
const dimensions = EXPORT_SIZES.flatMap((group) => group.sizes);
const maxWidth = Math.max(...dimensions.map(([w]) => w));
const maxHeight = Math.max(...dimensions.map(([, h]) => h));

// Serializes preset reads with patches, so an earlier slow read cannot erase a later write.
export class Output {
  constructor({ presets, effects, version }) {
    this.presets = presets;
    this.effects = effects;
    this.version = version;
    this.state = { mode: 'camera', size: { w: 1920, h: 1080 }, preset: null, params: {} };
    this.tags = {};
    this.presetBody = null;
    // Where the operator was looking when they last moved. `web/main.js` streams a pose only when it
    // changes, so a source that connects while the operator is still gets nothing else, and mirror
    // mode would draw it at the boot pose. Held beside `presetBody` rather than in `state`: this is
    // what a new page is told, not a field of the output.
    this.lastView = null;
    this.pending = Promise.resolve();
  }

  // The pose goes with a mirror-mode reader only: the program camera is what `camera` mode draws,
  // and telling a page a pose it will not use is a claim about the picture that is not true.
  messages() {
    const { mode, size, params } = this.state;
    return [
      { mode, size },
      ...(this.presetBody ? [{ preset: this.presetBody }] : []),
      ...(Object.keys(params).length ? [{ params }] : []),
      ...(mode === 'mirror' && this.lastView ? [{ view: this.lastView }] : []),
    ];
  }

  write(patch) {
    const result = this.pending.then(() => this.apply(patch));
    this.pending = result.catch(() => {});
    return result;
  }

  async apply(patch) {
    if (!object(patch)) refuse('output must be an object');
    if (Object.keys(patch).some((key) => !['mode', 'size', 'preset', 'params', 'tags', 'view'].includes(key))) {
      refuse('output accepts mode, size, preset, params, tags and view');
    }
    if ('mode' in patch && !['camera', 'mirror'].includes(patch.mode)) refuse('output mode must be camera or mirror');
    if ('size' in patch && (!object(patch.size) || !Number.isInteger(patch.size.w)
        || !Number.isInteger(patch.size.h) || patch.size.w <= 0 || patch.size.h <= 0
        || patch.size.w > maxWidth || patch.size.h > maxHeight)) {
      refuse(`output size must be positive integers at most ${maxWidth}x${maxHeight}`);
    }
    for (const key of ['params', 'tags']) {
      if (key in patch && !object(patch[key])) refuse(`${key} must be an object`);
    }
    if ('view' in patch && !pose(patch.view)) refuse('view must be a position, a quaternion and a fov');
    const next = { ...this.state, params: { ...this.state.params } };
    let presetBody = this.presetBody;
    if ('preset' in patch) {
      if (typeof patch.preset !== 'string' || !patch.preset.trim()) refuse('preset must be a name');
      let doc;
      try { doc = await this.presets.read(patch.preset); }
      catch (err) {
        // The store's word for a name with no file rather than the filesystem's: this sentence lands
        // in the operator's readout, and a preset name is the only thing an operator can act on.
        if (err?.code === 'ENOENT') refuse(`no preset named ${patch.preset}`, 404);
        refuse(err.message, 400);
      }
      if (doc.body?.version !== this.version) {
        refuse(`preset ${patch.preset} is version ${doc.body?.version}; this build reads version ${this.version}`, 409);
      }
      if (!Array.isArray(doc.body.requires)) refuse('preset requires must be a list', 409);
      const installed = new Set(this.effects.list().map((effect) => effect.id));
      for (const requirement of doc.body.requires) {
        if (!installed.has(requirement?.id)) refuse(`preset requires missing effect ${requirement?.id}`, 409);
      }
      presetBody = doc.body;
      next.preset = patch.preset;
      for (const key of Object.keys(next.params)) {
        if (!composition.has(key) && (this.tags[key] ?? 'look') === 'look') delete next.params[key];
      }
    }
    if ('mode' in patch) next.mode = patch.mode;
    if ('view' in patch) this.lastView = patch.view;
    if ('size' in patch) next.size = { w: patch.size.w, h: patch.size.h };
    if (patch.params) next.params = { ...next.params, ...patch.params };
    this.tags = { ...this.tags, ...patch.tags };
    this.presetBody = presetBody;
    this.state = next;
    return next;
  }
}
