/**
 * The document format's version, stamped by the page as it saves and by the server as it
 * writes, so there is one number rather than two that agree.
 *
 * A document from any other version is refused, naming the version it found, rather than
 * opened on a best guess: this build ships no conversion and no reader of a second shape.
 * Version 8 carries a `clips` array - each clip its own take, placement, speed, in-point and
 * the look values that write the cloud - beside the `look` block holding the ones that write
 * the post chain. Version 7 placed its footage with a keyframed retime curve instead of the
 * `speed` and `sourceStart` pair.
 */
export const PROJECT_VERSION = 8;

/**
 * How many clips this build composites.
 *
 * A clip costs a cloud whether it is on screen or not - four textures and two float targets -
 * and what it costs per frame is set by how many are live at once, which the edit decides rather
 * than the document's length. Eight is the document gate; `docs/performance.md` carries what the
 * overlap actually costs. Here rather than in the editor because the media picker refuses a pick
 * that would cross it, and a second number would let the two disagree about what fits.
 */
export const CLIP_CEILING = 8;

/**
 * The sentence a document from the wrong version gets, in one place because two doors saying
 * different things about one file is how one of them ends up false. A version that is not a
 * finite number is its own band, because it says nothing about older or newer.
 */
export function versionRefusal(what, version) {
  const across = !Number.isFinite(version)
    ? 'its version field is absent or is not a number, so it is not a document this build can '
      + 'place at all - which says nothing about whether it is older or newer'
    : version > PROJECT_VERSION
      ? 'it is from a later build than this one, so nothing here knows what it means - this build is '
        + 'the thing to move, not the document'
      : `nothing in this build reads a document that old and there is no path from here to `
        + `${PROJECT_VERSION}, because this repo ships no conversion`;
  return `${what} is version ${JSON.stringify(version)} and this build reads version ${PROJECT_VERSION}: ${across}`;
}

/**
 * The generation of the capture format this build writes and reads. A take is the one thing
 * in this program that cannot be made again, so a hello carrying a format this build does
 * not know is refused rather than unprojected on assumptions that may not be its own. A
 * hello with no `format` key at all is generation zero and opens - every take on disk today
 * is one, and nothing here rewrites a capture.
 *
 * `native/grabber.cpp` stamps this number too, and `syntax-check` holds the two spellings to
 * each other.
 */
export const CAPTURE_FORMAT = 1;

/**
 * The sentence a take from a format this build cannot read gets, and the predicate behind
 * it: empty when the take may be opened, the reason when it may not. One function rather
 * than a comparison at each of the four doors, which drift as soon as the band gains a
 * member.
 */
export function captureFormatRefusal(what, format) {
  // Absent and an explicit null are one answer: `describeTake` ships a value rather than the
  // key's presence, so reading the difference would cost a second channel through the listing.
  if (format === null || format === undefined) return '';
  if (format === CAPTURE_FORMAT) return '';
  return `${what} was written in capture format ${JSON.stringify(format)} and this build reads `
    + `format ${CAPTURE_FORMAT}: nothing here knows what geometry that generation recorded, and a `
    + 'take is the one thing in this program that cannot be made again, so it is refused rather '
    + 'than unprojected on assumptions that may not be its own';
}

/**
 * What may be a take id: a name the recorder mints, since nothing types one. One expression,
 * imported by both sides: the page's copy is a courtesy and the gate is `server/library.js`,
 * because a request does not have to come from this page at all. The leading character rules
 * out `..`.
 */
export const VALID_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * The longest a document name may be. A directory entry holds 255 bytes on every filesystem this
 * runs on and the file the name makes carries `.json` after it, so the cap is on the filename and
 * the name itself is five bytes shorter.
 */
export const MAX_DOCUMENT_NAME_BYTES = 255 - '.json'.length;

/**
 * A document name held to what may be joined to a path, as a sentence or null. A person types this
 * one where nothing types a take id, so it allows a space - and it is the second expression
 * guarding the same join as `VALID_ID`, so it is written with the same suspicion: what it names is
 * a floor, and `DocumentStore.pathFor` checks the path it produces on top of it.
 *
 * Case and Unicode normal form are the volume's answer rather than this rule's: `Beach` and
 * `beach`, or one name in NFC and the same one in NFD, are one document on APFS and two on ext4.
 */
export function documentNameRefusal(kind, name) {
  if (typeof name !== 'string' || name.length === 0) {
    return `a ${kind} needs a name and this one is ${JSON.stringify(name)}, which is not one`;
  }
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > MAX_DOCUMENT_NAME_BYTES) {
    return `this ${kind} name is ${bytes} bytes and ${MAX_DOCUMENT_NAME_BYTES} is the most a name can be: `
      + 'the file it makes carries .json after it and a directory entry holds 255 bytes, so a longer '
      + 'name is refused here with a reason rather than by the filesystem with an errno';
  }
  if (name.includes('..')) {
    return `${JSON.stringify(name)} cannot be a ${kind} name: it carries .., which walks out of the `
      + `directory ${kind}s are kept in`;
  }
  if (name.startsWith('.')) {
    return `${JSON.stringify(name)} cannot be a ${kind} name: it starts with a dot, which hides the `
      + 'file from the directory this program lists';
  }
  if (name.includes('/') || name.includes('\\')) {
    return `${JSON.stringify(name)} cannot be a ${kind} name: it carries a slash, and a name is one `
      + 'entry in one directory rather than a path';
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return `${JSON.stringify(name)} cannot be a ${kind} name: it carries a control character, which `
      + 'nothing can read off a list and type back';
  }
  if (name !== name.trim()) {
    return `${JSON.stringify(name)} cannot be a ${kind} name: it starts or ends with a space, and two `
      + 'names differing by one are the same name to everybody reading the list';
  }
  return null;
}

/**
 * The next free `Untitled N`. A name allocation and not a count: `Untitled 2` can be free while
 * `Untitled 1` and `Untitled 3` are taken, and handing out `Untitled 3` again would collide.
 */
export function nextUntitledName(taken) {
  for (let n = 1; ; n++) {
    if (!taken.has(`Untitled ${n}`)) return `Untitled ${n}`;
  }
}

/**
 * Finder's rule: `Untitled 4` becomes `Untitled 4 copy`, then `copy 2`, `copy 3`. A copy of a
 * copy keeps the one base rather than growing `copy copy`.
 */
export function copyName(name, taken) {
  const already = /^(.*) copy(?: (\d+))?$/.exec(name);
  const base = already ? already[1] : name;
  if (!taken.has(`${base} copy`)) return `${base} copy`;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} copy ${n}`)) return `${base} copy ${n}`;
  }
}

/**
 * The sensor's depth grid, here for the same delivery reason: the browser can only import
 * what the server serves, and Node reaches for it by path.
 *
 * `native/grabber.cpp` declares the pair a second time and that one is correct, since no
 * import reaches a C++ translation unit. `syntax-check` holds the two spellings to each
 * other, so a device with a different grid changes both files and nothing between them.
 */
export const DEPTH_W = 512;
export const DEPTH_H = 424;

/** How many cells that grid has, declared once rather than multiplied out at each site. */
export const POINTS = DEPTH_W * DEPTH_H;

/**
 * The effect a dotted look name belongs to, or null for a core parameter. The loader and the
 * render queue in `server/jobs.js` both split names by it, so a copy would let the two doors
 * refuse differently.
 */
export const effectOf = (name) => {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : null;
};

/** The effect ids a set of look names touches, in first-appearance order. */
export const effectIdsIn = (names) => [...new Set(names.map(effectOf).filter(Boolean))];

/** Whether a look name belongs in a preset when its panel group is known. */
export const presetCarriesLookName = (name, group) => group !== 'framing' || effectOf(name) !== null;

/** The id shape a `requires` entry names, which a package directory and a namespace share. */
const REQUIRES_ID = /^[a-z][a-z0-9]*$/;

/** Whether a `requires` list is a list at all, as a sentence or null. */
export const requiresListRefusal = (what, requires) => (Array.isArray(requires) ? null
  : `${what} carries ${JSON.stringify(requires)} where its requires belong: a requires list is an array of { id, version } entries`);

/**
 * One `requires` entry held to its shape, as a sentence or null. The render queue reads the
 * list too and used to compare id sets alone, so a malformed entry cost a browser launch and
 * a minute of GPU before the loader refused the same document from the other end.
 */
export function requiresEntryRefusal(what, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${what} carries a requires entry ${JSON.stringify(entry)}: each entry is an object with an id and a version`;
  }
  const strays = Object.keys(entry).filter((k) => !['id', 'version', 'rev'].includes(k));
  if (strays.length) {
    return `${what} carries ${strays.join(', ')} on a requires entry, which has no place there: an entry is id, version and optionally rev`;
  }
  if (typeof entry.id !== 'string' || !REQUIRES_ID.test(entry.id)) {
    return `${what} requires ${JSON.stringify(entry.id)}, which is not an effect id: an id is lowercase letters and digits, the prefix its parameters carry`;
  }
  if (typeof entry.version !== 'string' || entry.version.length === 0) {
    return `${what} requires ${entry.id} at version ${JSON.stringify(entry.version)}: a version is a non-empty string`;
  }
  if (entry.rev !== undefined && (typeof entry.rev !== 'string' || entry.rev.length === 0)) {
    return `${what} pins ${entry.id} to rev ${JSON.stringify(entry.rev)}: a rev is a non-empty string when it is there at all`;
  }
  return null;
}

/**
 * How many decimal places a number is written to, which is how far the registry rounds a
 * value after snapping it. The exponent is read because `String(1e-7)` has no dot in it,
 * and a step read as zero decimals rounds every value of its parameter to a whole number.
 */
export const decimalsOf = (x) => {
  const s = String(x);
  const e = s.search(/[eE]/);
  if (e < 0) {
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
  }
  const mantissa = s.slice(0, e);
  const dot = mantissa.indexOf('.');
  const fraction = dot < 0 ? 0 : mantissa.length - dot - 1;
  return Math.min(100, Math.max(0, fraction - Number(s.slice(e + 1))));
};

/**
 * Where a scalar lands: clamped into its bounds, snapped onto the step grid its `min`
 * anchors, and rounded to the decimals `min` and `step` imply. The install door runs this
 * rather than describing it. Without the `toFixed` trip, `0 + 55 * 0.01` is
 * 0.5500000000000001 where the slider says 0.55.
 */
export const snapScalar = (spec, value) => {
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const snapped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  const decimals = Math.max(decimalsOf(spec.min), decimalsOf(spec.step));
  return Math.min(spec.max, Math.max(spec.min, Number(snapped.toFixed(decimals))));
};
