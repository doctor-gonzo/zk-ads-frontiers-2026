// Publishes the landing page's fictional example (the Slop Cannon) from a run
// folder made with the command-line tool: its story page and videos, rendered
// here with the card renderer and marked fictional, and its bare orbit, go to
// R2 beside the cards, where the worker serves them at /example/. The concept
// and a record of how it was made stay in examples/slop-cannon/.
//
//   node scripts/example.mjs <run-dir>           render the story, publish
//   node scripts/example.mjs <run-dir> --local   publish to wrangler dev's R2
//
// The run folder also needs web/orbit.mp4, the orbit cut for the landing page
// (examples/slop-cannon/README.md has the commands).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';
import { validateConcept } from '../lib/concept.mjs';
import { readConcept } from '../lib/pipeline.mjs';
import { readRun, writeJson } from '../lib/run.mjs';
import { renderShare } from '../lib/share.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { local: { type: 'boolean', default: false } } });
const dir = positionals[0] && resolve(positionals[0]);
if (!dir || !existsSync(join(dir, 'concept.json'))) throw new Error('Give a run folder with a concept.json, e.g. out/20261013-202031-the-slop-cannon');
const envPath = join(root, '.env');
const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
if (!values.local && !(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.ZKADS_PUBLIC_URL)) throw new Error('Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and ZKADS_PUBLIC_URL in .env first.');
const site = values.local ? 'http://localhost:8787' : new URL(env.ZKADS_PUBLIC_URL).origin;
const orbit = join(dir, 'web', 'orbit.mp4');
if (!existsSync(orbit)) throw new Error(`${orbit} is missing: cut the landing page's orbit first.`);

const concept = readConcept(dir);
const run = readRun(dir);
// Only the example's own run: published as fictional, it must not be a real person's card.
const example = validateConcept(JSON.parse(readFileSync(join(root, 'examples/slop-cannon/concept.json'), 'utf8')), { stored: true });
if (run.input?.source !== 'concept file' || !isDeepStrictEqual(concept, example)) throw new Error('This run is not the Slop Cannon example: its concept must be examples/slop-cannon/concept.json, from a concept file.');
console.log(`Rendering the story for "${concept.product_name}" (fictional, links to ${site})…`);
const out = await renderShare({ dir, concept, run, site, fictional: true });
if (!out.video || !out.story) throw new Error('The story needs the run’s orbit.mp4.');

// Wrangler gets the Cloudflare credentials, not the rest of .env.
const wranglerEnv = { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? '', CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? '' };
const files = [
  ['index.html', join(dir, 'index.html'), 'text/html; charset=utf-8'],
  ['poster.jpg', join(dir, 'poster.jpg'), 'image/jpeg'],
  ['ad.mp4', join(dir, 'ad.mp4'), 'video/mp4'],
  ['story.mp4', join(dir, 'story.mp4'), 'video/mp4'],
  ['orbit.mp4', orbit, 'video/mp4'],
];
for (const [name, path, type] of files) {
  console.log(`Uploading example/${name}…`);
  const { status } = spawnSync(process.execPath, [join(root, 'scripts/wrangler.mjs'), 'r2', 'object', 'put', `zkads-media/example/${name}`, '--file', path, '--content-type', type, values.local ? '--local' : '--remote', '--env-file', devNull], { cwd: root, env: wranglerEnv, stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}

// The record kept with the code: the models, prompts, settings and prices,
// without the paid jobs' queue ids or download links.
const strip = (job) => job && Object.fromEntries(Object.entries(job).filter(([key]) => !['queue_id', 'download_url'].includes(key)));
writeJson(join(root, 'examples/slop-cannon/run.json'), { created: run.created, input: run.input, concept: run.concept, image: run.image, video: strip(run.video), orbit: run.orbit, music: strip(run.music) ?? null });
console.log(`\nPublished: ${site}/example/ (and ${site}/example/orbit.mp4). Run record: examples/slop-cannon/run.json`);
