// Deploys the worker with this deployment's settings, read from .env (which
// git ignores) unless set in the environment: CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID for wrangler; ZKADS_PUBLIC_URL, the worker's address
// (also the web app's and the passkeys' domain, and the worker's custom domain,
// with www. for a bare domain); ZKADS_ENCLAVE_URL once the
// render service runs; and the secrets ZKADS_ADMIN_TOKEN and
// ZKADS_ENCLAVE_SECRET, set on the worker each time.
//
//   npm run deploy
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZKADS_PUBLIC_URL', 'ZKADS_ADMIN_TOKEN', 'ZKADS_ENCLAVE_SECRET'].filter((name) => !env[name]);
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in .env first.`);
  process.exit(1);
}
// (The worker refuses a shorter admin token, so every admin call would fail.)
for (const name of ['ZKADS_ADMIN_TOKEN', 'ZKADS_ENCLAVE_SECRET']) {
  if (env[name].length < 32) {
    console.error(`${name} must be at least 32 characters.`);
    process.exit(1);
  }
}

// A lapse time, if any, must be a moment in the next week, in milliseconds.
const until = env.ZKADS_ENCLAVE_URL_UNTIL;
if (until && !(/^\d+$/.test(until) && Number(until) > Date.now() && Number(until) <= Date.now() + 7 * 86_400_000)) {
  console.error('ZKADS_ENCLAVE_URL_UNTIL must be a time within the next week, in milliseconds since 1970.');
  process.exit(1);
}

const site = new URL(env.ZKADS_PUBLIC_URL);
// (A fully qualified name's trailing dot would make another origin than the one people visit.)
site.hostname = site.hostname.replace(/\.$/, '');
const vars = { PUBLIC_URL: site.origin, APP_ORIGIN: site.origin, RP_ID: site.hostname };
// Until the render service is deployed, cards answer "renderer unavailable".
// ZKADS_ENCLAVE_URL_UNTIL (ms) makes the address lapse (the Venice test tunnel's).
if (env.ZKADS_ENCLAVE_URL) Object.assign(vars, { ENCLAVE_URL: env.ZKADS_ENCLAVE_URL, ENCLAVE_PUBLIC_URL: env.ZKADS_ENCLAVE_URL, ...(env.ZKADS_ENCLAVE_URL_UNTIL ? { ENCLAVE_URL_UNTIL: env.ZKADS_ENCLAVE_URL_UNTIL } : {}) });

// Wrangler gets the Cloudflare credentials, not the rest of .env (which it
// would otherwise read itself, so it is pointed at an empty env file).
const wranglerEnv = { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID };
const wrangler = (args, input) => spawnSync(process.execPath, [join(root, 'scripts/wrangler.mjs'), ...args, '--env-file', devNull], { cwd: root, env: wranglerEnv, input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
const run = (args, input) => {
  const { status } = wrangler(args, input);
  if (status !== 0) process.exit(status ?? 1);
};

// The site's own domain is the worker's custom domain (Cloudflare makes its
// DNS records), with www. for a bare domain such as zkads.lol. A workers.dev
// address, an IP address or localhost needs none.
const host = site.hostname;
const custom = !/(^|\.)(workers\.dev|localhost)$/.test(host) && !/^([\d.]+|\[[\da-f:.]+\])$/i.test(host);
const domains = custom ? [host, ...(host.split('.').length === 2 ? [`www.${host}`] : [])] : [];
run(['deploy', ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]), ...domains.flatMap((domain) => ['--domain', domain])]);
// Secrets go in through stdin, never on a command line.
run(['secret', 'put', 'ADMIN_TOKEN'], env.ZKADS_ADMIN_TOKEN);
run(['secret', 'put', 'ENCLAVE_SECRET'], env.ZKADS_ENCLAVE_SECRET);
console.log(`\nDeployed: ${site.origin}`);
