#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { parse, format, VERBS } from './verbs.js';

async function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log('braindance [--url URL] [--json] <verb>\n' + VERBS.map((row) => `  ${row.verb}`).join('\n')
      + '\nUse sensor wake --wait, camera color|low-light on|off, output mode camera|mirror,\noutput size WxH, output preset NAME, or output set key=value ... (JSON values).');
    return;
  }
  let command;
  try { command = parse(process.argv.slice(2), process.env); }
  catch (err) { console.error(err.message); process.exitCode = 2; return; }
  const request = async (route, method = 'GET', body) => {
    let res;
    try {
      res = await fetch(command.url + route, {
        method, signal: AbortSignal.timeout(60000),
        ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (err) { throw Object.assign(new Error(`no server answered at ${command.url}: ${err.message}`), { exit: 2 }); }
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { exit: 1 });
    return data;
  };
  try {
    let result = await request(command.route, command.method, command.body);
    if (command.wait) {
      const deadline = Date.now() + 60000;
      do {
        result = await request('/sensor/health');
        if (result.state === 'live') break;
        if (['lost', 'absent'].includes(result.state)) throw Object.assign(new Error(`sensor is ${result.state}`), { exit: 1 });
        if (Date.now() >= deadline) throw Object.assign(new Error('sensor did not wake within 60 seconds'), { exit: 1 });
        await sleep(200);
      } while (true);
    }
    if (command.read) result = await request(command.read);
    if (command.verb === 'status') {
      result = { sensor: result, recording: await request('/record/state'), output: await request('/output') };
    }
    console.log(command.json ? JSON.stringify(result) : format(result));
  } catch (err) { console.error(err.message); process.exitCode = err.exit ?? 2; }
}
await main();
