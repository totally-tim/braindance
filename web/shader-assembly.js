// The programs this page compiles, assembled out of a core spine each and whatever effect
// packages are installed.
//
// **Every spine is assembled in one call, and that is a refusal rather than a convenience.**
// There are two of them now - the point cloud's pair in `web/cloud-shader.js` and the grade
// pass's in `web/grade-shader.js` - and a chunk names the joint it joins, never the program
// it belongs to. So the joints of every spine are collected together before a package is
// read, one name means one place across all of them, and a chunk naming a joint nothing
// holds is refused by name. Assembling one spine at a time would have made that refusal
// impossible: the grade's assembly would meet the glyph field's `v.decl` chunk, and the only
// two answers available would be to throw on a chunk that is perfectly well placed
// elsewhere, or to skip it - which is the same silent absence as a typo, wearing the clothes
// of a design. The alternative considered and rejected was tagging every chunk with its
// program's name, which reintroduces exactly that: a tag nobody spelled right lands the
// chunk in no program at all, the page boots, and the effect is simply gone.
//
// **Assembly is concatenation and nothing else.** A chunk's text is spliced between two
// verbatim segments exactly as it arrived - not re-indented, not substituted into, not
// wrapped - because the property this whole split rested on is that the shipped set
// assembles to the four literals the two files used to hold, byte for byte, and every
// transformation on the way is a byte that can move. While the split was landing,
// `test/shader-assembly.test.mjs` held that equality against the last revision carrying
// each monolith; that arm is retired with the extraction it was scaffolding for, and the
// standing evidence is the ten-look probe recorded in `docs/performance.md`. What is left
// here to be right about is placement, and the test still refuses a flipped byte in any
// chunk that fails to move exactly the program its name promises.
//
// **Nothing is imported here and nothing may be.** The spine is data handed in and the
// packages are data handed in, so this module is a pure function of its two arguments -
// which is what lets the gate assemble the shipped tree under bare node, with no page and
// no server standing around it, and perturb one rule at a time. The same argument
// `web/effect-manifests.js` makes about the registry's conversion: one statement of it,
// used by the live page and by the test, because a test with its own copy of the
// assembler would be a second assembler agreeing with itself.
//
// The four kinds of joint a spine can hold, and each is a different question:
//
//   - a **stage** takes any number of chunks, concatenated in the order they declare.
//     Declaration blocks and helper tables are stages: two packages both adding uniforms
//     is the ordinary case, not a conflict.
//   - a **slot** takes at most one chunk and carries the text to use when nothing claims
//     it. A slot is a *replacement* - the glyph field's point-size branch stands where
//     the old clamp line stood - so two claimants is a refusal rather than a
//     concatenation nobody could read.
//   - a **service** is a value the spine computes under a gate generated from whoever
//     needs it: the condition is the `when` of every package consuming it, joined with
//     `||` in `gateOrder`, and the spine's own `open`, `body` and `close` are the text
//     around it. With no consumers the whole thing disappears, which is the point - a
//     build with neither glyph nor rain installed must not pay a mat3 multiply and two
//     hashes per point for a cell nothing reads.
//
//     **A service that closes something it opened is a scope, and that changes what its
//     consumers owe it.** `cell` opens a block, so `room` and `wc` are locals of that
//     block and a consumer's chunk has to go *inside* it - which is why a chunk naming a
//     service as its stage takes its place from `gateOrder` rather than from an `order`
//     of its own: the term in the gate and the block it opens are one placement. `region`
//     closes nothing: it computes `rw` at the surrounding scope, its consumers read that
//     value from wherever they happen to sit, and their chunks are placed by the stage or
//     slot they name. So the two services ask their consumers for different things, and
//     the refusals below are written per shape rather than as one rule that would have to
//     be wrong about one of them.
//   - a **varying declaration** is generated from the packages' `varyings` entries, in
//     three places out of one declaration: the vertex `out`, the fragment `in`, and the
//     line in the prologue that gives it its inert value above the early returns. One
//     statement rather than three, because an `out` with no `in` is a link error and an
//     `in` with no prologue write is undefined-register roulette on every shed point -
//     and a package declaring the three separately could get any pair of them out of
//     step.
//
// Every refusal below names the silent failure it is standing in front of. A chunk
// naming a joint that is not there would otherwise assemble into nothing at all: the
// page boots, the shader compiles, and the effect is simply absent with no error
// anywhere - which is the exact shape this repo keeps case files about.

const byOrder = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every joint every spine holds, by kind.
 *
 * Collected before any package is read so a chunk can be refused against the spines
 * rather than against whatever happens to be in the map by the time it is reached, and
 * a name declared twice is refused here: two joints sharing a name would take one
 * package's chunk to two places, which compiles and draws twice. **Across the spines and
 * not within one**, which is what makes one name mean one place in the whole build - two
 * spines both offering a `decl` would otherwise be a chunk that lands in a program its
 * author never named, and no arm anywhere would report it as anything but a look that
 * changed.
 */
const jointsOf = (spines) => {
  const stages = new Set();
  const slots = new Map();
  const services = new Map();
  const claim = (name, where) => {
    if (stages.has(name) || slots.has(name) || services.has(name)) {
      throw new Error(`the shader spines declare ${JSON.stringify(name)} twice, so a chunk naming it would be spliced in two places`);
    }
    if (where === 'stage') stages.add(name);
  };
  for (const spine of Object.values(spines)) {
    for (const program of [spine.vertex, spine.fragment]) {
      for (const entry of program) {
        if (entry.stage !== undefined) claim(entry.stage, 'stage');
        // The entry rather than the name alone, because whether a service opens a scope
        // decides what its consumers owe it, and that is a property of the spine's text.
        else if (entry.service !== undefined) {
          claim(entry.service, 'service');
          services.set(entry.service, entry);
        } else if (entry.slot !== undefined) {
          claim(entry.slot, 'slot');
          slots.set(entry.slot, entry);
        }
      }
    }
  }
  return { stages, slots, services };
};

/**
 * One package's chunk text, or a refusal naming what was not fetched.
 *
 * The manifest lists the files and the caller fetches them, so a chunk the manifest
 * names and the caller did not bring is a package half-loaded - and half-loaded
 * assembles to a program missing one block, which compiles as often as not.
 */
const chunkText = (pkg, file) => {
  const text = pkg.chunks?.[file];
  if (typeof text !== 'string') {
    throw new Error(`effect ${pkg.id} declares the chunk ${JSON.stringify(file)} and its text was not loaded - `
      + 'a package assembled without one of its chunks is a program with a block missing');
  }
  return text;
};

/**
 * Every program, as source text, from the spines and the installed packages.
 *
 * `spines` is a map of program name to spine, and the answer is a map of the same names to
 * a `{ vertexShader, fragmentShader }` pair each - so the caller asks for a program by the
 * name it handed in rather than by position, and adding a third spine is one more key at
 * both ends.
 *
 * `packages` are the objects `/effects/:id` answers with, each carrying its `manifest`
 * and a `chunks` map of file name to text. A package with no `chunks` section in its
 * manifest contributes nothing and is not an error: some of the sixteen shipped effects
 * are parameters over code a spine already holds. That number was "most" while the glyph
 * field, the rain, the glitch and the lattice were the only packages carrying GLSL, it was
 * eight against eight once the region family moved out, and the tone run and the grade
 * leave three - a sentence worth keeping current rather than approximately true, since it
 * is the one a reader checks before wondering why their package assembled to nothing.
 */
export function assembleShaders(spines, packages) {
  const joints = jointsOf(spines);
  const stages = new Map([...joints.stages].map((name) => [name, []]));
  const slots = new Map();
  const services = new Map([...joints.services.keys()].map((name) => [name, []]));
  const varyings = [];
  const declared = new Set();

  for (const pkg of packages) {
    const manifest = pkg.manifest ?? {};
    const consumes = new Map();
    for (const c of manifest.consumes ?? []) {
      if (!joints.services.has(c.service)) {
        throw new Error(`effect ${pkg.id} consumes the service ${JSON.stringify(c.service)}, which this shader spine does not offer`);
      }
      if (typeof c.when !== 'string' || c.when.length === 0) {
        throw new Error(`effect ${pkg.id} consumes ${c.service} without a \`when\`, so nothing would open the gate it needs`);
      }
      if (!Number.isFinite(c.gateOrder)) {
        throw new Error(`effect ${pkg.id} consumes ${c.service} without a numeric \`gateOrder\`, and where its term sits in the condition decides the text`);
      }
      if (consumes.has(c.service)) {
        throw new Error(`effect ${pkg.id} consumes ${c.service} twice, and one package gets one term in a gate`);
      }
      consumes.set(c.service, c);
    }

    for (const v of manifest.varyings ?? []) {
      if (declared.has(v.name)) {
        throw new Error(`${v.name} is declared by two effects - a varying is one channel, and two packages writing it would be two effects sharing one register`);
      }
      declared.add(v.name);
      varyings.push({ ...v, id: pkg.id });
    }

    const filled = new Map();
    // **A package may point two joints at one file and may not point one joint at a file
    // twice**, and the difference is what a chunk costs when it is spliced. The first is
    // ordinary - one piece of text belonging in a declaration block and in a body - and
    // `readEffectPackages` fetches it once for exactly that reason. The second is the same
    // text compiled twice into one place, which nothing legitimate wants and which no bound
    // upstream of here can see: a package is measured by the bytes it *carries*, and the
    // descriptor list is what decides how many times those bytes are emitted. A thousand
    // entries naming one 493-byte chunk carries 493 bytes and assembles into half a megabyte
    // of fragment shader.
    //
    // Refused here rather than at the install door because the door asks this assembler,
    // so the rule covers a package written into the store past the door as well - which is
    // the state `effect-check` section 9 stands up on purpose. The slot and service joints
    // already refuse their own repeats a few lines down; a stage takes any number of chunks
    // and so had nothing saying that any number means any number of *different* ones.
    const claimed = new Set();
    for (const c of manifest.chunks ?? []) {
      const text = chunkText(pkg, c.file);
      const claim = `${c.slot !== undefined ? 'slot' : 'stage'} ${c.slot ?? c.stage}\0${c.file}`;
      if (claimed.has(claim)) {
        throw new Error(`effect ${pkg.id}'s ${c.file} is spliced into ${JSON.stringify(c.slot ?? c.stage)} twice - `
          + 'a manifest may point two joints at one file, and one joint at one file twice is the same text '
          + 'compiled twice into one place');
      }
      claimed.add(claim);
      if (c.slot !== undefined) {
        if (!joints.slots.has(c.slot)) {
          throw new Error(`effect ${pkg.id}'s ${c.file} claims the slot ${JSON.stringify(c.slot)}, which this shader spine does not hold`);
        }
        const held = slots.get(c.slot);
        if (held) {
          throw new Error(`${held.id} and ${pkg.id} both claim the slot ${c.slot} - a slot is a replacement, so two claimants is two programs`);
        }
        slots.set(c.slot, { id: pkg.id, text });
        continue;
      }
      if (c.stage === undefined) {
        throw new Error(`effect ${pkg.id}'s ${c.file} names neither a stage nor a slot, so nothing decides where it goes`);
      }
      // A chunk on a service stage takes its place from the `consumes` entry rather than
      // from an `order` of its own: the term in the gate and the block inside it are one
      // placement, and two numbers for one fact is the drift this design keeps refusing.
      if (joints.services.has(c.stage)) {
        const consumed = consumes.get(c.stage);
        if (!consumed) {
          throw new Error(`effect ${pkg.id}'s ${c.file} fills the ${c.stage} service without consuming it, so nothing would open the gate around it`);
        }
        if (c.order !== undefined) {
          throw new Error(`effect ${pkg.id}'s ${c.file} carries an \`order\` as well as ${c.stage}'s \`gateOrder\` - the gate term and the block it opens are one placement`);
        }
        if (filled.has(c.stage)) {
          throw new Error(`effect ${pkg.id} fills the ${c.stage} service twice, and one consumer gets one block`);
        }
        filled.set(c.stage, text);
        continue;
      }
      if (!joints.stages.has(c.stage)) {
        throw new Error(`effect ${pkg.id}'s ${c.file} names the stage ${JSON.stringify(c.stage)}, which this shader spine does not hold`);
      }
      if (!Number.isFinite(c.order)) {
        throw new Error(`effect ${pkg.id}'s ${c.file} joins ${c.stage} without a numeric \`order\`, and a stage's text is its chunks in order`);
      }
      stages.get(c.stage).push({ id: pkg.id, order: c.order, text });
    }

    // **A consumer widens a gate, so a consumer that contributes nothing is a build paying
    // for a value nobody reads** - and what counts as contributing depends on whether the
    // service opens a scope. A consumer of `cell` has to fill it: its chunk reads locals
    // that exist only inside that block, so a chunk anywhere else would not compile and a
    // consumer with no chunk at all is a mat3 multiply and two hashes bought for nothing.
    // A consumer of `region` reads `rw` at the surrounding scope and puts its own text in
    // whatever stage or slot it names, so what it owes is a chunk somewhere - the failure
    // being refused is the same one either way, a term in the condition with nothing behind
    // it, and only the place the something has to be differs.
    //
    // **The gate term comes from `consumes` and never from the chunk**, which is the half
    // this loop had backwards while `cell` was the only service: the consumer list used to
    // be built where a chunk filled the service, so a package consuming one and putting its
    // text somewhere else declared a `when` nothing ever read, and the gate came out one
    // term short with no error anywhere. Every consumer joins the condition here; the text
    // it puts inside is whatever it filled the service with, or nothing.
    for (const [service, consumed] of consumes) {
      if (joints.services.get(service).close.length > 0) {
        if (!filled.has(service)) {
          throw new Error(`effect ${pkg.id} consumes the ${service} scope and brings no chunk for it, so it would widen the gate and put nothing inside it`);
        }
      } else if ((manifest.chunks ?? []).length === 0) {
        throw new Error(`effect ${pkg.id} consumes ${service} and brings no chunk at all, so it would widen the gate and nothing would read the value behind it`);
      }
      services.get(service).push({
        id: pkg.id, order: consumed.gateOrder, when: consumed.when, text: filled.get(service) ?? '',
      });
    }
  }

  for (const list of stages.values()) list.sort(byOrder);
  for (const list of services.values()) list.sort(byOrder);
  varyings.sort(byOrder);

  const emit = (program) => {
    let out = '';
    for (const entry of program) {
      if (entry.text !== undefined) out += entry.text;
      else if (entry.varyings === 'out') out += varyings.map((v) => `out ${v.type} ${v.name};\n`).join('');
      else if (entry.varyings === 'in') out += varyings.map((v) => `in ${v.type} ${v.name};\n`).join('');
      else if (entry.varyings === 'init') out += varyings.map((v) => `  ${v.name} = ${v.init};\n`).join('');
      else if (entry.stage !== undefined) out += stages.get(entry.stage).map((c) => c.text).join('');
      else if (entry.slot !== undefined) out += (slots.get(entry.slot)?.text ?? entry.fallback);
      else if (entry.service !== undefined) {
        const consumers = services.get(entry.service);
        if (consumers.length === 0) continue;
        // Four pieces and none of them assumed: the spine carries the text either side of
        // the condition and after the chunks, so an `if` block and a conditional expression
        // are the same joint with different text rather than two kinds. The alternative was
        // baking `if (` and `) {` in here, which is a fact about one shader living inside a
        // concatenator that is supposed to know nothing about GLSL at all.
        out += entry.open;
        out += consumers.map((c) => c.when).join(' || ');
        out += entry.body;
        out += consumers.map((c) => c.text).join('');
        out += entry.close;
      } else {
        throw new Error(`the shader spine holds an entry of no kind this assembler knows: ${JSON.stringify(Object.keys(entry))}`);
      }
    }
    return out;
  };

  return Object.fromEntries(Object.entries(spines).map(([name, spine]) => [
    name, { vertexShader: emit(spine.vertex), fragmentShader: emit(spine.fragment) },
  ]));
}
