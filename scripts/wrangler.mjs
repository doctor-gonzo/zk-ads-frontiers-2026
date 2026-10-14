// Runs the project's wrangler with its logs, registry and temp files kept in
// .wrangler/ and usage metrics off.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.wrangler');
mkdirSync(join(runtime, 'tmp'), { recursive: true });
const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_LOG_PATH: join(runtime, 'logs'), WRANGLER_REGISTRY_PATH: join(runtime, 'registry'), WRANGLER_SEND_METRICS: 'false', TMPDIR: join(runtime, 'tmp') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
// Killed by a signal (no code) is a failure, so callers such as deploy.mjs stop.
child.on('exit', (code) => process.exit(code ?? 1));
