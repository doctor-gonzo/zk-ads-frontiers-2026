#!/usr/bin/env node
// ZK Ads v1: chat history -> fictional product concept -> hero image ->
// 360° orbit video + music -> shareable flip-card ad. No TEE or on-chain parts yet.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  askForConcept,
  buildClaudePrompt,
  buildConceptRequest,
  buildEnrichPrompt,
  CONCEPT_SCHEMA,
  MAX_HISTORY_CHARS,
  parseConcept,
  parsePersonDetails,
  PROMPT_VERSION,
  slugify,
  validateConcept,
} from './lib/concept.mjs';
import { imageCost, imageRequest, MUSIC_MODEL, musicRequest, ORBIT_MODEL, textCost, videoRequest } from './lib/media.mjs';
import { ASPECT, makeImage, makeMusic, makeOrbit, readConcept } from './lib/pipeline.mjs';
import { readJson, readRun, updateRun, writeJson } from './lib/run.mjs';
import { renderShare, storyLength } from './lib/share.mjs';
import { createVenice, describe } from './lib/venice.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out');
const REASONING = 'high';
// A card with every page filled in, for sizing the music in price quotes.
const FULL_CARD = {
  archetype: 'x', stat_value: '1', stat_label: 'x', rabbit_hole: 'x', era_match: 'x',
  reasons: [{ you: 'x', so: 'x' }, { you: 'x', so: 'x' }, { you: 'x', so: 'x' }],
  catalogue: [{ name: 'x', era: 'x', teaser: 'x' }, { name: 'x', era: 'x', teaser: 'x' }],
};

const USAGE = `ZK Ads v1: for an audience of one.

  node zkads.mjs make --history <file|-> [options]   all steps, new run in out/
  node zkads.mjs make --concept <file|-> [options]   skip the concept step: use JSON
                                                     from your own assistant
  node zkads.mjs prompt [--artist] [--era] [--name]  print the prompt for your assistant
  node zkads.mjs prompt <run-dir>                    print the prompt that adds the
                                                     details about you to that run
  node zkads.mjs enrich <run-dir> --concept <file|-> add those details from the reply
  node zkads.mjs concept --history <file|-> [opts]   concept only, new run
  node zkads.mjs image <run-dir> [--image-model id]  (re)generate hero.png
  node zkads.mjs orbit <run-dir> [--seconds n] [--hd]  360° video -> orbit.mp4
  node zkads.mjs music <run-dir> [--music-model id]  period music bed -> music.*
  node zkads.mjs share <run-dir>                     story.mp4, ad.mp4, poster, page
  node zkads.mjs quote [--seconds n] [--hd]          price check, no key needed

Options
  --history <file|->  dossier or chat text ("-" reads stdin)
  --concept <file|->  concept JSON, or a pasted assistant reply containing it
  --artist <name>     artist whose style to use (default: inferred)
  --era <e>           scifi | historical | any (default any)
  --name <name>       display name for the ad (default: none)
  --llm <id>          Venice text model (default kimi-k3)
  --image-model <id>  Venice image model (default gpt-image-2-5-sunburst)
  --video-model <id>  Venice image-to-video model (default ${ORBIT_MODEL})
  --music-model <id>  Venice music model (default ${MUSIC_MODEL})
  --seconds <n>       orbit length (default 8)
  --hd                2K image and 1080p video instead of 1K and 768p
  --no-video          make: skip the orbit and music (poster and page only)
  --sound <s>         video: the video model's own soundtrack (default)
                      music: a separate music model
  --no-music          make, orbit: no sound at all (no music, no sound from the video)

A paid video or music job that is interrupted stays recorded in run.json;
running that step again on the same folder collects it without paying twice.`;

const OPTIONS = {
  history: { type: 'string' },
  concept: { type: 'string' },
  artist: { type: 'string' },
  era: { type: 'string', default: 'any' },
  name: { type: 'string' },
  llm: { type: 'string', default: 'kimi-k3' },
  'image-model': { type: 'string', default: 'gpt-image-2-5-sunburst' },
  'video-model': { type: 'string', default: ORBIT_MODEL },
  'music-model': { type: 'string', default: MUSIC_MODEL },
  seconds: { type: 'string', default: '8' },
  hd: { type: 'boolean', default: false },
  'no-video': { type: 'boolean', default: false },
  'no-music': { type: 'boolean', default: false },
  sound: { type: 'string', default: 'video' },
  help: { type: 'boolean', short: 'h', default: false },
};

let opts, venice, command, runArg;
try {
  const parsed = parseArgs({ allowPositionals: true, options: OPTIONS });
  opts = parsed.values;
  [command, runArg] = parsed.positionals;
  if (!['video', 'music'].includes(opts.sound)) throw new Error('--sound must be video or music.');
  loadEnv(join(ROOT, '.env'));
  venice = createVenice({ apiKey: process.env.VENICE_API_KEY });
  await main();
} catch (error) {
  console.error(`\n✗ ${describe(error)}`);
  process.exitCode = 1;
}

async function main() {
  if (opts.help || !command) return console.log(USAGE);
  const seconds = Number(opts.seconds);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('--seconds must be a whole number.');
  const steps = {
    make: async () => {
      requireKey();
      const dir = opts.concept ? importStep() : await conceptStep();
      await imageStep(dir);
      if (!opts['no-video']) {
        await orbitStep(dir, seconds);
        if (opts.sound === 'music' && !opts['no-music']) {
          try {
            await musicStep(dir);
          } catch (error) {
            // The paid video is already safe; finish the ad without music.
            console.error(`\n  Music failed (${describe(error)}). Continuing without it; later run: node zkads.mjs music ${show(dir)} && node zkads.mjs share ${show(dir)}`);
          }
        }
      }
      await shareStep(dir);
    },
    concept: conceptStep,
    prompt: () => console.log(runArg ? buildEnrichPrompt(readConcept(runDir())) : buildClaudePrompt({ artist: opts.artist, era: opts.era, name: opts.name })),
    enrich: () => enrichStep(runDir()),
    image: () => imageStep(runDir()),
    orbit: () => orbitStep(runDir(), seconds),
    music: () => musicStep(runDir()),
    share: () => shareStep(runDir()),
    quote: () => quote(seconds),
  };
  if (!steps[command]) throw new Error(`Unknown command "${command}". Run with --help.`);
  await steps[command]();
}

async function conceptStep() {
  requireKey();
  if (!opts.history) throw new Error('--history is required (a file path, or "-" for stdin).');
  const history = readFileSync(opts.history === '-' ? 0 : resolve(opts.history), 'utf8');
  const spec = await venice.model('text', opts.llm);
  const caps = spec.model_spec?.capabilities ?? {};
  const supportsSchema = Boolean(caps.supportsResponseSchema);
  const request = buildConceptRequest({ history, artist: opts.artist, era: opts.era, name: opts.name, supportsSchema });
  if (request.truncated) console.log(`  History has ${request.chars.toLocaleString()} characters; using the first ${MAX_HISTORY_CHARS.toLocaleString()}.`);

  const started = step('Concept', `${opts.llm} is reading ${request.chars.toLocaleString()} characters of history…`);
  const { reply, concept } = await askForConcept(
    (user) =>
      venice.chat({
        model: opts.llm,
        system: request.system,
        user,
        schema: supportsSchema ? CONCEPT_SCHEMA : undefined,
        reasoningEffort: caps.reasoningEffortOptions?.includes(REASONING) ? REASONING : undefined,
      }),
    request.user,
  );
  const { usage } = reply;
  const dir = createRun(concept, {
    input: { chars: request.chars, truncated: request.truncated, artist: opts.artist ?? null, era: opts.era, name: opts.name ?? null },
    concept: { model: opts.llm, privacy: spec.model_spec?.privacy, prompt: PROMPT_VERSION, usage, usd: textCost(spec, usage), seconds: since(started) },
  });
  done(started, `"${concept.product_name}" (${concept.era}), style after ${concept.artist}`);
  console.log(`  ${concept.tagline}`);
  console.log(`  Run folder: ${show(dir)}`);
  return dir;
}

// Starts a run from a concept the person's own assistant wrote, so the
// history itself never reaches ZKAds.
function importStep() {
  if (opts.history) throw new Error('Use either --history or --concept, not both.');
  const concept = parseConcept(readFileSync(opts.concept === '-' ? 0 : resolve(opts.concept), 'utf8'));
  const dir = createRun(concept, {
    input: { source: 'concept file', name: opts.name ?? null },
    concept: { model: 'your own assistant', source: 'import' },
  });
  console.log(`\nConcept imported "${concept.product_name}" (${concept.era}), style after ${concept.artist}`);
  console.log(`  Run folder: ${show(dir)}`);
  return dir;
}

function createRun(concept, runInfo) {
  const base = join(OUT, `${timestamp()}-${slugify(concept.product_name)}`);
  mkdirSync(OUT, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(dir);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    writeJson(join(dir, 'concept.json'), concept);
    updateRun(dir, { created: new Date().toISOString(), ...runInfo });
    return dir;
  }
}

async function imageStep(dir) {
  requireKey();
  let started = Date.now();
  const { file } = await makeImage({ venice, dir, model: opts['image-model'], hd: opts.hd, announce: (message) => (started = step('Image', message)) });
  done(started, `hero.png (also saved as ${file})`);
}

async function orbitStep(dir, seconds) {
  requireKey();
  await paidStep('Orbit', (hooks) => makeOrbit({ venice, dir, model: opts['video-model'], seconds, hd: opts.hd, sound: opts['no-music'] ? 'none' : opts.sound, resumeCommand: `node zkads.mjs orbit ${show(dir)}`, hooks }));
}

async function musicStep(dir) {
  requireKey();
  await paidStep('Music', (hooks) => makeMusic({ venice, dir, model: opts['music-model'], fallbackSeconds: Number(opts.seconds), resumeCommand: `node zkads.mjs music ${show(dir)}`, hooks }));
}

// Runs one paid step with terminal progress for the job runner's hooks.
async function paidStep(label, run) {
  let started = Date.now();
  const { file } = await run({
    announce: (message) => {
      started = step(label, message);
    },
    note: (message) => console.log(`\n  ${message}`),
    progress: ({ execution_duration: ran, average_execution_time: typical }) =>
      process.stdout.write(`\r  …${clock(ran)} elapsed${typical ? ` (typically ~${clock(typical)})` : ''}   `),
  });
  process.stdout.write('\n');
  done(started, file);
}

// Adds the back-of-card details from the person's assistant to an existing
// run, keeping its product, image, video and music.
function enrichStep(dir) {
  if (!opts.concept) throw new Error('--concept is required (the reply to `prompt <run-dir>`, a file or "-").');
  const raw = readJson(join(dir, 'concept.json'));
  const details = parsePersonDetails(readFileSync(opts.concept === '-' ? 0 : resolve(opts.concept), 'utf8'));
  const concept = validateConcept({ ...raw, ...details });
  writeJson(join(dir, 'concept.json'), concept);
  const added = Object.keys(details).filter((key) => !(key.startsWith('stat_') && details[key] === ''));
  const cleared = details.stat_value === '' ? ' The stat was left off (no honest count).' : '';
  console.log(`\nEnrich  added ${added.join(', ') || 'no new details'} to ${show(join(dir, 'concept.json'))}.${cleared}`);
  console.log(`  Now run: node zkads.mjs share ${show(dir)}`);
}

async function shareStep(dir) {
  const concept = readConcept(dir);
  const runInfo = readRun(dir);
  const started = step('Share', 'setting the type, rendering the pages and mixing the sound…');
  const out = await renderShare({ dir, concept, run: runInfo, name: runInfo.input?.name });
  done(started, [out.story, out.video, out.poster, 'index.html'].filter(Boolean).join(', '));
  const usd = ['concept', 'image', 'video', 'music'].map((k) => runInfo[k]?.usd).filter((n) => typeof n === 'number');
  console.log(`\nOpen ${show(join(dir, 'index.html'))}${usd.length ? `  ·  total ≈ $${usd.reduce((a, b) => a + b, 0).toFixed(2)}` : ''}`);
}

async function quote(seconds) {
  const spec = await venice.model('video', opts['video-model']);
  const body = videoRequest(spec, { prompt: 'quote', imageDataUrl: 'data:,', seconds, hd: opts.hd });
  const usd = await venice.quote('video', { model: body.model, duration: body.duration, resolution: body.resolution });
  const image = await venice.model('image', opts['image-model']);
  const imageBody = imageRequest(image, { prompt: 'quote', aspectRatio: ASPECT, hd: opts.hd });
  const imageUsd = imageCost(image, imageBody);
  console.log(`Video  ${spec.id} ${body.duration} ${body.resolution ?? ''}${opts.sound === 'video' ? ', with its own sound' : ''}: $${usd.toFixed(2)}`);
  console.log(`Image  ${image.id} ${imageBody.resolution ?? ''}: ${imageUsd == null ? 'see model pricing' : `$${imageUsd.toFixed(2)}`}`);
  if (opts.sound === 'music') {
    const musicSpec = await venice.model('music', opts['music-model']);
    const musicBody = musicRequest(musicSpec, { prompt: 'quote', seconds: storyLength(FULL_CARD, seconds) + 1 });
    const musicUsd = await venice.quote('audio', { model: musicBody.model, duration_seconds: musicBody.duration_seconds });
    console.log(`Music  ${musicSpec.id} ${musicBody.duration_seconds ? `${musicBody.duration_seconds}s` : ''}: $${musicUsd.toFixed(2)}`);
  }
  console.log('Concept  usually a few cents of text-model tokens');
}

function requireKey() {
  if (!process.env.VENICE_API_KEY) throw new Error('VENICE_API_KEY is not set. Copy .env.example to .env and add your key.');
}

function runDir() {
  if (!runArg) throw new Error(`"${command}" needs a run folder, e.g. out/20261013-202031-the-slop-cannon`);
  const dir = resolve(runArg);
  if (!existsSync(join(dir, 'concept.json'))) throw new Error(`${runArg} has no concept.json.`);
  return dir;
}

function loadEnv(path) {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function show(path) {
  return relative(process.cwd(), path) || '.';
}

function step(label, message) {
  console.log(`\n${label.padEnd(8)}${message}`);
  return Date.now();
}

function done(started, message) {
  console.log(`  ✓ ${message} · ${since(started)}s`);
}

function since(started) {
  return Math.round((Date.now() - started) / 1000);
}

function clock(ms = 0) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}
