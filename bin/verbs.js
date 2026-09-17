const exact = (args, count) => { if (args.length !== count) throw new Error('wrong number of arguments'); };
const empty = (args) => { exact(args, 0); return {}; };
const toggle = (key) => (args) => {
  exact(args, 1);
  if (!['on', 'off'].includes(args[0])) throw new Error('use on or off');
  return { [key]: args[0] === 'on' };
};
const one = (key) => (args) => { exact(args, 1); return { [key]: args[0] }; };
export const VERBS = [
  { verb: 'status', route: '/sensor/health', method: 'GET', body: empty },
  { verb: 'sensor status', route: '/sensor/health', method: 'GET', body: empty },
  { verb: 'sensor standby', route: '/sensor/standby', method: 'POST', body: empty, read: '/sensor/health' },
  { verb: 'sensor wake', route: '/sensor/wake', method: 'POST', body: empty, read: '/sensor/health' },
  ...['start', 'stop', 'mark'].map((verb) => ({ verb: `record ${verb}`, route: `/record/${verb}`, method: 'POST', body: empty, read: '/record/state' })),
  { verb: 'camera color', route: '/sensor/camera', method: 'POST', body: toggle('color'), read: '/sensor/camera' },
  { verb: 'camera low-light', route: '/sensor/camera', method: 'POST', body: toggle('lowLight'), read: '/sensor/camera' },
  { verb: 'output', route: '/output', method: 'GET', body: empty },
  { verb: 'output mode', route: '/output', method: 'POST', body: (args) => {
    const value = one('mode')(args);
    if (!['camera', 'mirror'].includes(value.mode)) throw new Error('mode must be camera or mirror');
    return value;
  }, read: '/output' },
  { verb: 'output size', route: '/output', method: 'POST', body: (args) => {
    exact(args, 1);
    const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(args[0]);
    if (!match) throw new Error('size must be WxH');
    return { size: { w: Number(match[1]), h: Number(match[2]) } };
  }, read: '/output' },
  { verb: 'output preset', route: '/output', method: 'POST', body: one('preset'), read: '/output' },
  { verb: 'output set', route: '/output', method: 'POST', body: (args) => {
    if (!args.length) throw new Error('set needs key=value');
    const entries = args.map((arg) => {
      const i = arg.indexOf('=');
      if (i < 1 || i === arg.length - 1) throw new Error('set needs key=value');
      let value;
      try { value = JSON.parse(arg.slice(i + 1)); }
      catch { throw new Error(`value for ${arg.slice(0, i)} must be JSON`); }
      return [arg.slice(0, i), value];
    });
    return { params: Object.fromEntries(entries) };
  }, read: '/output' },
  ...['presets', 'takes', 'jobs'].map((verb) => ({ verb, route: verb === 'takes' ? '/library/takes' : `/${verb}`, method: 'GET', body: empty })),
];

// Store editors and render workers use document revisions or leases rather than these controls.
export const MUTATION_EXEMPTIONS = [
  '/capture/:id/marks', '/library/download/:id', '/library/delete/:id', '/library/reclaim/:id',
  '/library/sync-marks/:id', '/library/rename/:id', '/library/reveal/:id',
  '/projects/:name', '/projects/:name/rename', '/presets/:name', '/deliverables/:name',
  '/effects/:id', '/effect-refusals', '/jobs', '/jobs/claim', '/jobs/:id/finish',
  '/jobs/:id/heartbeat', '/jobs/:id/requeue',
];

export function parse(argv, env = {}) {
  let url = env.BRAINDANCE_URL || 'http://127.0.0.1:8080';
  let json = false;
  let wait = false;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === '--url') { if (!argv[i + 1]) throw new Error('--url needs a URL'); url = argv[++i]; }
    else if (word === '--json') json = true;
    else if (word === '--wait') wait = true;
    else if (word.startsWith('--')) throw new Error(`unknown option ${word}`);
    else words.push(word);
  }
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('--url must be HTTP or HTTPS');
  const spec = [...VERBS].sort((a, b) => b.verb.length - a.verb.length).find((row) => {
    const parts = row.verb.split(' ');
    return parts.every((part, i) => words[i] === part);
  });
  if (!spec) throw new Error('unknown command; use --help');
  if (wait && spec.verb !== 'sensor wake') throw new Error('--wait is only for sensor wake');
  return { ...spec, body: spec.body(words.slice(spec.verb.split(' ').length)), url: target.origin, json, wait };
}

export function format(value, prefix = '') {
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return `${prefix || 'state'}: ${JSON.stringify(value)}`;
    return entries.map(([key, item]) => format(item, prefix ? `${prefix}.${key}` : key)).join('\n');
  }
  return `${prefix}: ${value}`;
}
