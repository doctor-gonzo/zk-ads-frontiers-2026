// Runs the render service on this computer, rendering with Venice (not in a
// TEE), and points the deployed worker at it through a temporary Cloudflare
// tunnel, so the live site makes real cards before the Phala deployment
// exists. Needs cloudflared (`brew install cloudflared`). .env is left as it
// is: when this stops, it redeploys with ZKADS_ENCLAVE_URL from .env (the
// Phala URL, once there is one), or with no renderer.
//
//   npm run renderer:venice     (Ctrl-C stops it; cards then answer "renderer unavailable")
//
// Not a TEE: a summary uploaded while this runs lands on this computer, so use
// it for your own tests, not with other people. Each card buys Venice media.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
const missing = ['VENICE_API_KEY', 'ZKADS_PUBLIC_URL', 'ZKADS_ENCLAVE_SECRET', 'ZKADS_ADMIN_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !settings[name]);
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in .env first.`);
  process.exit(1);
}
if (settings.ZKADS_ADMIN_TOKEN.length < 32 || settings.ZKADS_ENCLAVE_SECRET.length < 32) {
  console.error('ZKADS_ADMIN_TOKEN and ZKADS_ENCLAVE_SECRET must be at least 32 characters.');
  process.exit(1);
}
// The worker stops using the tunnel after this long, even if this script
// never gets to point it back (killed, crashed): restart it to keep going.
const HOURS = 24;

const children = [];
// The deploy pointing the worker at the tunnel, once started, and its end.
let pointing = null;
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  // The worker stops using the tunnel's address, which Cloudflare may later
  // give to someone else: after the deploy pointing at it (so that one
  // cannot land last), a deploy with .env's address.
  if (pointing) {
    await pointing;
    console.error('Pointing the worker back at ZKADS_ENCLAVE_URL from .env (or at no renderer)…');
    // In its own process group and writing nowhere, so closing the terminal,
    // a second Ctrl-C or this script dying does not cut it short.
    const restore = spawn(process.execPath, [join(root, 'scripts/deploy.mjs')], { cwd: root, detached: true, stdio: 'ignore' });
    const status = await new Promise((done) => restore.on('exit', done).on('error', () => done(1)));
    if (status !== 0) console.error('That deploy failed: run `npm run deploy` yourself.');
  }
  process.exit(code);
};
// (SIGHUP: the terminal closed, so writes to it may fail; the cleanup still runs.)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
const start = (name, command, args, options) => {
  const child = spawn(command, args, options);
  children.push(child);
  child.on('error', (error) => (console.error(`Could not run ${name}: ${error.message}`), stop(1)));
  child.on('exit', (code) => (console.error(`The ${name} stopped (${code}).`), stop(1)));
  return child;
};

// Only what the render service needs. (Reclaim stays off until its provider is
// pinned in enclave/docker-compose.yml: the service refuses a placeholder.)
start('render service', process.execPath, [join(root, 'enclave/server.mjs')], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    ENCLAVE_SECRET: settings.ZKADS_ENCLAVE_SECRET,
    WORKER_URL: new URL(settings.ZKADS_PUBLIC_URL).origin,
    VENICE_API_KEY: settings.VENICE_API_KEY,
    ...(settings.CONFIDENTIAL_AI_KEY ? { CONFIDENTIAL_AI_KEY: settings.CONFIDENTIAL_AI_KEY } : {}),
  },
});
// Its metrics address says when it is connected to Cloudflare (this computer's
// own DNS may not know the new hostname for a while; the worker's does).
const METRICS = '127.0.0.1:20299';
const tunnel = start('tunnel', 'cloudflared', ['tunnel', '--no-autoupdate', '--metrics', METRICS, '--url', 'http://127.0.0.1:8788'], { stdio: ['ignore', 'pipe', 'pipe'] });

const ready = async (url) => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  return false;
};

// cloudflared prints the tunnel's address once it is assigned.
let announced = false;
const watch = async (chunk) => {
  const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || announced) return;
  announced = true;
  if (!(await ready('http://127.0.0.1:8788/health')) || !(await ready(`http://${METRICS}/ready`))) {
    console.error('The render service or the tunnel did not come up.');
    return stop(1);
  }
  // Point the worker at the tunnel: a deploy with this address in place of .env's.
  if (stopping) return;
  const deploy = spawn(process.execPath, [join(root, 'scripts/deploy.mjs')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ZKADS_ENCLAVE_URL: url, ZKADS_ENCLAVE_URL_UNTIL: String(Date.now() + HOURS * 3_600_000) } });
  pointing = new Promise((done) => deploy.on('exit', done).on('error', () => done(1)));
  const status = await pointing;
  if (stopping) return;
  if (status !== 0) {
    console.error('Could not point the worker at the tunnel (npm run deploy failed).');
    return stop(1);
  }
  console.log(`\nReady: cards made on ${settings.ZKADS_PUBLIC_URL} now render on this computer with Venice.
Not a TEE: summaries sent while this runs land on this computer, so keep it to your own tests.
Agents: "Read ${new URL(settings.ZKADS_PUBLIC_URL).origin}/skill.md and make me a ZKAds card."
The worker uses this tunnel for ${HOURS} hours at most; restart this to keep going.
Ctrl-C stops it and points the worker back at .env's ZKADS_ENCLAVE_URL.`);
};
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);
