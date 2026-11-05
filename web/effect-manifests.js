// From fetched packages to the registry's vocabulary, in one place. A manifest states a
// parameter the way its author wrote it and the registry wants a flat entry, and this is the one
// statement of that conversion - imported by `web/main.js` for the live page and by the gate
// under bare node, because a test that re-implemented it would be a second statement agreeing
// with itself. Pure functions of their arguments: where a package came from must not matter.

/**
 * The generation of the package format this build reads. A manifest declaring a higher number,
 * or none at all, is refused at the install door rather than adapted - a package written against
 * a later build may mean something different by a field this one thinks it understands.
 */
export const MANIFEST_FORMAT = 1;

/**
 * The closed vocabularies a manifest is written in, stated once because both ends consume them:
 * the install door refuses a manifest outside these sets and the client's applier implements
 * exactly them. A transform the door allowed and the applier did not know would install cleanly
 * and throw on its first write.
 *
 * `kind` is two entries and not three, because `pose` is the camera's and no uniform could take
 * one. Frozen, because a closed set anybody could push onto is not a closed set.
 */
export const EFFECT_PARAM_KINDS = Object.freeze(['scalar', 'step']);
export const EFFECT_BIND_TABLES = Object.freeze(['points', 'grade', 'mosh']);

/**
 * The tables whose pass is switched off while every term on it is zero, so a term there may
 * declare `gates`. The cloud is drawn whatever the look says and has nothing to hold open.
 */
export const EFFECT_GATED_TABLES = Object.freeze(['grade', 'mosh']);

/**
 * The tables whose pass carries a frame of memory, so a term there has to say how long that
 * memory can last. A feedback pass with no ceiling on its own history cannot be seeked into: no
 * length of pre-roll reproduces a frame that depends on every frame before it, which is the
 * failure `MAX_AGE` in `web/surface-memory.js` exists to prevent one table over. A package
 * binding here declares exactly one parameter with `bounds`, in seconds, and the render loop
 * refreshes the pass whenever that many seconds have gone by.
 */
export const EFFECT_BOUNDED_TABLES = Object.freeze(['mosh']);
const EFFECT_BIND_TRANSFORM_TYPES = Object.freeze({
  axisDeg: 'vec2',
  centeredEdges: 'vec2',
  degToRad: 'float',
});
export const EFFECT_BIND_TRANSFORMS = Object.freeze(Object.keys(EFFECT_BIND_TRANSFORM_TYPES));
export const effectBindUniformType = (transform) => (
  transform === undefined ? 'float' : EFFECT_BIND_TRANSFORM_TYPES[transform] ?? null
);

/**
 * The uniforms this build's own render loop writes, which is the one exception to the rule that
 * a package's uniform has to be bound by one of that package's parameters.
 *
 * A uniform nothing writes reads zero for the life of the page, so `hostDriven` is as closed as
 * the rule it excuses. `rainPhase` is the whole set: `renderProgramFrame` writes it once a frame
 * from program time, as a second cell beside `uniforms.time` so that
 * `timeline-check --mutate rain-accumulates` has one line to integrate.
 *
 * `test/effect-door.test.mjs` reads `web/main.js` and refuses a name here the page does not
 * actually write, which is the drift this constant is about.
 */
export const HOST_DRIVEN_UNIFORMS = Object.freeze(['rainPhase']);

/**
 * The panel groups the client's own spine holds, as a set, sorted so it reads as one.
 *
 * The install door needs this and cannot reach `CORE_PANEL_GROUPS` in `web/main.js`, which
 * carries prose and DOM closures and lives behind a top-level await. Two statements, held equal
 * at boot by `withEffectGroups` rather than trusted, so a core group renamed without this line
 * following is a page that does not boot rather than a door quietly refusing a correct package.
 * Membership only and never order: the panel's order belongs to the list carrying the prose.
 */
export const CORE_PANEL_GROUP_KEYS = Object.freeze([
  'colour', 'displacement', 'framing', 'motion', 'points',
  'post', 'region', 'signal', 'style', 'viewer',
]);

/**
 * Every declared parameter name, in the order the registry declares them: the ones the client's
 * order places, in that order, and then everything else.
 *
 * The placed set is a hand-written layout fact about the shipped effects, so it may not be
 * regenerated or reordered by a package arriving at runtime - but a new effect has to land
 * somewhere. Packages are taken by id in lexical order and each keeps its manifest declaration
 * order, so the appendix is contiguous per package and deterministic. A fork that adds a
 * parameter therefore appends it rather than seating it beside its siblings.
 *
 * With the shipped set installed the appendix is empty and this returns the order unchanged.
 * `effect-check` drives the single-package case; the between-package ordering is asserted
 * nowhere, which anybody adding a second unplaced package should read as the gap it is.
 */
const placeParams = (packages, order) => {
  const placed = new Set(order);
  const appendix = [];
  for (const p of [...packages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const short of Object.keys(p.manifest.params)) {
      const name = `${p.id}.${short}`;
      if (!placed.has(name)) appendix.push(name);
    }
  }
  return [...order, ...appendix];
};

/**
 * The flat table the registry assembles from, one entry per declared parameter, in the order
 * `placeParams` decides. The order handed in is a full list of dotted names rather than of
 * effect ids, because the registry's declaration order interleaves below effect granularity and
 * that placement is the client's layout fact.
 *
 * A name the order lists that no installed package declares throws, because the registry cannot
 * assemble an entry it has no parameter for. A declared name the order does not place is
 * appended instead - see `placeParams`.
 */
export const tableFromPackages = (packages, order) => {
  const declared = new Map();
  for (const p of packages) {
    for (const [short, spec] of Object.entries(p.manifest.params)) {
      declared.set(`${p.id}.${short}`, spec);
    }
  }
  const missing = order.filter((name) => !declared.has(name));
  if (missing.length) {
    throw new Error(`the effect order names ${missing.join(', ')} and no installed package declares `
      + `${missing.length === 1 ? 'it' : 'them'} - the registry cannot assemble entries it has no parameters for`);
  }
  const table = {};
  for (const name of placeParams(packages, order)) {
    const p = declared.get(name);
    const entry = {
      def: p.def, min: p.min, max: p.max, step: p.step, kind: p.kind, label: p.label,
      group: p.panel.group, on: p.bind.on, uniform: p.bind.uniform,
    };
    if (p.bind.transform !== undefined) entry.transform = p.bind.transform;
    if (p.bind.gates !== undefined) entry.gates = p.bind.gates;
    if (p.bind.bounds !== undefined) entry.bounds = p.bind.bounds;
    if (p.bind.cycles !== undefined) entry.cycles = p.bind.cycles;
    if (p.reading !== undefined) entry.reading = p.reading;
    if (p.under !== undefined) entry.under = `${name.slice(0, name.indexOf('.'))}.${p.under}`;
    table[name] = Object.freeze(entry);
  }
  return Object.freeze(table);
};

/**
 * The panel spine with each package's own groups spliced in. A group carries its anchor and an
 * `order` that decides among packages targeting one anchor, so the panel's shape never depends
 * on the order the packages were fetched in. An anchor the spine does not hold is a refusal.
 */
export const withEffectGroups = (coreGroups, packages) => {
  // The one place the door's copy of the core group keys is held to the list that declares
  // them. Compared as sets and refused by name: a door checking a vocabulary the page no longer
  // has refuses correct packages and accepts colliding ones.
  const held = [...coreGroups.map((g) => g.key)].sort();
  if (held.join(',') !== [...CORE_PANEL_GROUP_KEYS].sort().join(',')) {
    throw new Error(`the panel spine holds the groups ${held.join(', ')} and CORE_PANEL_GROUP_KEYS names `
      + `${[...CORE_PANEL_GROUP_KEYS].sort().join(', ')} - the install door reads the second one, so the two `
      + 'disagreeing is a door checking a vocabulary this page has not got');
  }
  const inserts = new Map();
  for (const p of packages) {
    for (const g of p.manifest.panelGroups ?? []) {
      if (!coreGroups.some((c) => c.key === g.after)) {
        throw new Error(`effect ${p.id} anchors its ${g.key} group after ${JSON.stringify(g.after)}, which is not a core group`);
      }
      if (!inserts.has(g.after)) inserts.set(g.after, []);
      inserts.get(g.after).push(g);
    }
  }
  const merged = [];
  for (const core of coreGroups) {
    merged.push(core);
    const here = (inserts.get(core.key) ?? []).sort((a, b) => (a.order - b.order) || (a.key < b.key ? -1 : 1));
    for (const g of here) {
      const group = { key: g.key, label: g.label, tab: g.tab };
      if (g.lookgroup !== undefined) group.lookgroup = g.lookgroup;
      if (g.collapses !== undefined) group.collapses = g.collapses;
      merged.push(group);
    }
  }
  return merged;
};
