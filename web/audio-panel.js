import { AUDIO_UPLOAD_BYTES } from './audio-source.js';

export function createAudioPanel({ getClip, targets, owners, selectedOwner, change, importFile, remove, open }) {
  const root = document.getElementById('audioGroup');
  const file = document.getElementById('audioFile');
  const name = document.getElementById('audioName');
  const controls = document.getElementById('audioControls');
  const note = document.getElementById('audioNote');
  const target = document.getElementById('audioTarget');
  const owner = document.getElementById('audioOwner');
  const effect = document.getElementById('audioEffect');
  const start = document.getElementById('audioStart');
  const depth = document.getElementById('audioDepth');
  const meter = document.getElementById('audioMeter');
  const readout = document.getElementById('audioValue');
  const spectrum = document.getElementById('audioSpectrum');
  const baseOut = document.getElementById('audioBase');
  const addedOut = document.getElementById('audioAdded');
  const resultOut = document.getElementById('audioResult');
  const resultMeter = document.getElementById('audioResultMeter');
  const inputs = new Map();
  let busy = false;
  let chosenOwner;
  const settingRows = [
    ['low', 'Low', -60, 24, 1, 'dB'],
    ['mid', 'Mid', -60, 24, 1, 'dB'],
    ['high', 'High', -60, 24, 1, 'dB'],
    ['gain', 'Gain', -24, 48, 1, 'dB'],
    ['floor', 'Threshold', -96, -1, 1, 'dB'],
    ['ceiling', 'Ceiling', -95, 0, 1, 'dB'],
    ['attack', 'Attack', 0, 2000, 1, 'ms'],
    ['release', 'Release', 0, 2000, 1, 'ms'],
  ];
  const run = async (work) => {
    if (busy) return;
    busy = true;
    root.querySelectorAll('button, input, select').forEach((el) => { el.disabled = true; });
    note.textContent = 'Analyzing audio…';
    try { await work(); note.textContent = ''; }
    catch (err) { note.textContent = err.message; }
    finally { busy = false; paint(); }
  };
  for (const [key, label, min, max, step, unit] of settingRows) {
    const row = document.createElement('label');
    row.className = 'audio-setting';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.id = `audio-${key}`;
    input.min = min; input.max = max; input.step = step;
    const out = document.createElement('output');
    const show = () => { out.value = `${input.value} ${unit}`; };
    input.addEventListener('input', show);
    input.addEventListener('change', () => run(() => change({ conditioning: { ...getClip().conditioning, [key]: Number(input.value) } })));
    inputs.set(key, { input, show });
    row.append(text, input, out);
    const group = ['low', 'mid', 'high'].includes(key) ? 'audioEqBands'
      : ['floor', 'ceiling', 'attack', 'release'].includes(key) ? 'audioAdvancedSettings' : 'audioSettings';
    document.getElementById(group).append(row);
  }
  document.getElementById('audioImport').addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    run(async () => {
      if (!picked.size) throw new Error('Audio file is empty');
      if (picked.size > AUDIO_UPLOAD_BYTES) throw new Error('Audio files must be 64 MiB or smaller');
      await importFile(picked);
    });
  });
  document.getElementById('audioRemove').addEventListener('click', () => run(remove));
  start.addEventListener('change', () => run(() => {
    if (start.value === '') throw new Error('Audio start needs a number');
    return change({ start: Number(start.value) });
  }));
  const selectTarget = (next) => run(() => {
    return change({ target: next ? { clip: next.clip, param: next.param, depth: (next.max - next.min) / 2 } : null });
  });
  owner.addEventListener('change', () => {
    chosenOwner = JSON.parse(owner.value);
    selectTarget(null);
  });
  effect.addEventListener('change', () => selectTarget(targets().find((t) => t.clip === chosenOwner && t.effect === effect.value)));
  target.addEventListener('change', () => selectTarget(targets().find((t) => t.clip === chosenOwner && t.param === target.value)));
  depth.addEventListener('change', () => run(() => {
    if (depth.value === '') throw new Error('Modulation depth needs a number');
    return change({ target: { ...getClip().target, depth: Number(depth.value) } });
  }));
  function paint() {
    if (busy) return;
    const clip = getClip();
    root.querySelectorAll('button, input, select').forEach((el) => { el.disabled = false; });
    document.getElementById('audioRemove').disabled = !clip;
    name.textContent = clip?.name ?? 'No audio';
    controls.hidden = !clip;
    if (!clip) return;
    start.value = clip.start;
    const options = targets();
    chosenOwner = clip.target ? clip.target.clip : chosenOwner === undefined ? selectedOwner() : chosenOwner;
    const availableOwners = owners();
    if (!availableOwners.some((item) => item.id === chosenOwner)) chosenOwner = selectedOwner();
    owner.replaceChildren(...availableOwners.map((item) => new Option(item.label, JSON.stringify(item.id))));
    owner.value = JSON.stringify(chosenOwner);
    const scoped = options.filter((item) => item.clip === chosenOwner);
    const effects = [...new Map(scoped.map((item) => [item.effect, item.effectLabel])).entries()];
    effect.replaceChildren(new Option(effects.length ? 'None' : 'No applied effects', ''), ...effects.map(([id, label]) => new Option(label, id)));
    effect.disabled = !effects.length;
    const selected = scoped.find((item) => item.param === clip.target?.param);
    effect.value = selected?.effect ?? '';
    document.getElementById('audioMappingTitle').textContent = selected ? `${chosenOwner ?? 'Project'} · ${selected.effectLabel} · ${selected.label}` : 'Choose effect';
    target.replaceChildren(...scoped.filter((item) => item.effect === selected?.effect).map((item) => new Option(item.label, item.param)));
    target.value = selected?.param ?? '';
    target.disabled = !selected;
    const spec = options.find((t) => t.clip === clip.target?.clip && t.param === clip.target?.param);
    depth.disabled = !spec;
    depth.value = clip.target?.depth ?? 0;
    depth.min = spec ? -(spec.max - spec.min) : -1e6;
    depth.max = spec ? spec.max - spec.min : 1e6;
    depth.step = spec?.step ?? 0.01;
    for (const [key, { input, show }] of inputs) { input.value = clip.conditioning[key]; show(); }
  }
  return {
    paint,
    visible: () => !root.hidden,
    open: () => { open(); paint(); },
    chooseFile: () => { open(); file.click(); },
    meter: ({ signal, base = null, result = null, min = 0, max = 1, bins = [] }) => {
      if (root.hidden) return;
      meter.value = signal; readout.value = signal.toFixed(3);
      const number = (n) => n === null ? '—' : Number(n.toFixed(4)).toString();
      baseOut.value = number(base);
      addedOut.value = number(result === null ? null : result - base);
      resultOut.value = number(result);
      resultMeter.value = result === null ? 0 : (result - min) / Math.max(1e-9, max - min);
      const points = (field) => bins.map((b, i) => `${i * 300 / 63},${Math.max(0, Math.min(100, -b[field] / 72 * 100))}`).join(' ');
      spectrum.querySelector('[data-spectrum=input]').setAttribute('points', points('input'));
      spectrum.querySelector('[data-spectrum=output]').setAttribute('points', points('output'));
    },
  };
}
