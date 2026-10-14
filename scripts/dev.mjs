// Runs the hosted stack locally: the worker (wrangler dev, port 8787) and the
// enclave render service (port 8788), sharing a service secret.
//
//   node scripts/dev.mjs                      renders with Venice (key in .env)
//   node scripts/dev.mjs --fixture <run dir>  reuses that run's media, free
//
// The first run writes .dev.vars with a fresh ADMIN_TOKEN and ENCLAVE_SECRET.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { fixture: { type: 'string' } } });
const varsPath = join(root, '.dev.vars');
if (!existsSync(varsPath)) {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync(varsPath, `ADMIN_TOKEN=${secret()}\nENCLAVE_SECRET=${secret()}\n`, { mode: 0o600 });
  console.log('Wrote .dev.vars with a new ADMIN_TOKEN and ENCLAVE_SECRET.');
}
const vars = Object.fromEntries(
  readFileSync(varsPath, 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]),
);
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const children = [
  run('enclave', [join(root, 'enclave/server.mjs')], {
    ENCLAVE_SECRET: vars.ENCLAVE_SECRET,
    WORKER_URL: 'http://127.0.0.1:8787',
    ...(values.fixture ? { ENCLAVE_FIXTURE: resolve(values.fixture) } : {}),
  }),
  run('worker', [join(root, 'scripts/wrangler.mjs'), 'dev', '--ip', '127.0.0.1', '--port', '8787'], {}),
];
console.log(`\nSite, API and card pages: http://localhost:8787 (passkeys need "localhost", not 127.0.0.1)
Skill for assistants: http://localhost:8787/skill.md
Make an invite code:
  curl -sS -X POST http://localhost:8787/v1/admin/invites -H "Authorization: Bearer $(grep ADMIN_TOKEN .dev.vars | cut -d= -f2)" -d '{"label":"me"}'\n`);

function run(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (stream) => stream.on('data', (chunk) => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, `[${name}] `)));
  prefix(child.stdout);
  prefix(child.stderr);
  child.on('exit', (code) => {
    console.log(`[${name}] exited (${code}); stopping.`);
    for (const other of children) other.kill('SIGTERM');
    process.exit(code ?? 1);
  });
  return child;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => children.forEach((child) => child.kill(signal)));
