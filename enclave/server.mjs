#!/usr/bin/env node
// ZKAds render service. The worker sends it render jobs; it makes the hero
// image, 360° orbit and music with Venice, renders the story page and video,
// and uploads them back to the worker. In production it runs in a Phala
// dstack container (a TEE); locally it is a plain Node process.
//
// It also holds history summaries, sealed: agents and browsers upload them
// straight here with a one-use token the worker signs, so the worker never
// sees them. A summary is read only here, by a confidential model (Phala
// Confidential AI, itself in a GPU TEE), to write a card's concept, fuse two
// people's items, or rank matching partners, and is deleted after 72 hours
// at most.
//
// ENCLAVE_FIXTURE=<run folder> reuses that folder's media and stands in for
// the models, so the whole hosted flow can be tested for free.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askForConcept, buildCatalogueRequest, buildConceptRequest, CONCEPT_SCHEMA, displayName, extractJson, plainText, validateConcept } from '../lib/concept.mjs';
import { CONFIDENTIAL_AI_URL, CONFIDENTIAL_MODEL, createConfidentialAI } from '../lib/confidential.mjs';
import { digest, MUSIC_MODEL, ORBIT_MODEL } from '../lib/media.mjs';
import { makeMedia, readConcept } from '../lib/pipeline.mjs';
import { readJson, readRun, updateRun, writeJson } from '../lib/run.mjs';
import { renderShare } from '../lib/share.mjs';
import { buildItemRequest, cleanItem, cleanSponsor, fitsFromCard, runAuction } from '../lib/brands.mjs';
import { buildFusionRequest, buildProfileRequest, cleanProfile, fixtureProfile, rankByTags, usageTags } from '../lib/together.mjs';
import { badgeFromStats, cleanBadge, cleanStats, formatCount } from '../lib/usage.mjs';
import { createVenice, describe } from '../lib/venice.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const HOST = env.HOST ?? '127.0.0.1';
const PORT = Number(env.PORT ?? 8788);
const SECRET = env.ENCLAVE_SECRET ?? '';
const WORKER_URL = (env.WORKER_URL ?? '').replace(/\/+$/, '');
const DATA = resolve(env.DATA_DIR ?? join(ROOT, 'out', 'enclave'));
const CARDS = join(DATA, 'cards');
const SUMMARIES = join(DATA, 'summaries');
const PROOFS = join(DATA, 'proofs');
const FIXTURE = env.ENCLAVE_FIXTURE ? resolve(env.ENCLAVE_FIXTURE) : null;
const MODELS = {
  image: env.IMAGE_MODEL ?? 'gpt-image-2-5-sunburst',
  video: env.VIDEO_MODEL ?? ORBIT_MODEL,
  music: env.MUSIC_MODEL ?? MUSIC_MODEL,
  concept: env.CONFIDENTIAL_MODEL ?? CONFIDENTIAL_MODEL,
  // A card from a catalogue item reads only public card text, so Venice writes it.
  text: env.TEXT_MODEL ?? 'kimi-k3',
  match: env.CONFIDENTIAL_MATCH_MODEL ?? 'openai/gpt-oss-120b',
};
// Where a card's sound comes from: the video model's own soundtrack (the
// default), or SOUND=music for a separate music model.
const SOUND = env.SOUND === 'music' ? 'music' : 'video';
// The dstack guest agent's socket exists only inside a Phala CVM.
const IN_TEE = existsSync('/var/run/dstack.sock');
const SUMMARY_HOURS_MAX = 72;
const MAX_SUMMARY_CHARS = 12_000;
const ORBIT_SECONDS = whole(env.ORBIT_SECONDS, 8);
// Finished cards' media lives in R2; the enclave keeps what a retry needs
// (hero, orbit, music, concept) for this many days.
const RETENTION_DAYS = whole(env.CARD_RETENTION_DAYS, 7);
const HEARTBEAT_MS = whole(env.HEARTBEAT_MS, 5 * 60_000);
// Venice jobs mostly wait; the page render is CPU-bound (Chrome and ffmpeg).
const mediaSlot = limiter(whole(env.MEDIA_JOBS, 12));
const pageSlot = limiter(whole(env.PAGE_JOBS, 2));

// Must match the worker's formats and its list of card files.
const CARD_ID = /^[a-z2-7]{20}$/;
const JOB_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CARD_FILES = { 'index.html': 'text/html; charset=utf-8', 'poster.jpg': 'image/jpeg', 'ad.mp4': 'video/mp4', 'story.mp4': 'video/mp4', 'attestation.json': 'application/json; charset=utf-8' };

if (SECRET.length < 32) fail('ENCLAVE_SECRET must be set to at least 32 characters (the worker holds the same value).');
if (!/^https:\/\//.test(WORKER_URL) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal)(:\d+)?$/.test(WORKER_URL)) {
  fail('WORKER_URL must be the worker’s https URL (plain http only for a local worker, such as http://127.0.0.1:8787).');
}
if (env.RECLAIM_APP_ID && (!env.RECLAIM_PROVIDER_ID || env.RECLAIM_PROVIDER_ID === 'PROVIDER-ID')) fail('Set RECLAIM_PROVIDER_ID in docker-compose.yml to the Codex usage provider before enabling proofs.');
if (env.RECLAIM_APP_ID && (!env.RECLAIM_PROVIDER_VERSION || env.RECLAIM_PROVIDER_VERSION === 'PROVIDER-VERSION')) fail('Set RECLAIM_PROVIDER_VERSION in docker-compose.yml to the exact provider version you checked before enabling proofs.');
// A pasted key with a line break would otherwise surface in fetch errors.
for (const name of ['VENICE_API_KEY', 'CONFIDENTIAL_AI_KEY']) if (env[name] && !/^[\x21-\x7e]+$/.test(env[name])) fail(`${name} contains spaces or invisible characters; paste it again.`);
if (FIXTURE && !['hero.png', 'orbit.mp4'].every((file) => existsSync(join(FIXTURE, file)))) fail(`ENCLAVE_FIXTURE needs hero.png and orbit.mp4 in ${FIXTURE}.`);
if (!FIXTURE && !env.VENICE_API_KEY) fail('VENICE_API_KEY is not set (or set ENCLAVE_FIXTURE to render with saved media for free).');
const venice = createVenice({ apiKey: env.VENICE_API_KEY });
const confidential = createConfidentialAI({ apiKey: env.CONFIDENTIAL_AI_KEY, baseUrl: env.CONFIDENTIAL_AI_URL ?? CONFIDENTIAL_AI_URL });
// A few model calls at a time, whatever the traffic. A call that is no longer
// wanted when its turn comes (`wanted` says no) is skipped.
const modelSlot = limiter(whole(env.MODEL_JOBS, 4));
const chat = (request, wanted = () => true) => modelSlot(() => (wanted() ? confidential.chat(request) : Promise.reject(new Error('it was no longer needed when its turn came'))));

// Card id → the running job, so a repeated request joins it instead of racing it.
const active = new Map();
// Codex proof sessions waiting for Reclaim's callback: ZKAds session → details.
const proofs = new Map();
const RECLAIM = {
  appId: env.RECLAIM_APP_ID,
  appSecret: env.RECLAIM_APP_SECRET,
  providerId: env.RECLAIM_PROVIDER_ID,
  // Pinned (like the id) in the attested compose file, so nobody can swap in
  // a new provider version that proves some other page.
  providerVersion: env.RECLAIM_PROVIDER_VERSION,
  tokensParam: env.RECLAIM_TOKENS_PARAM || 'tokens',
  // Popcorn's proofs carry its TEE attestation; require it unless set to 0.
  requireTee: env.RECLAIM_REQUIRE_TEE !== '0',
};
const FIXTURE_CODEX_TOKENS = 41_000_000;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://enclave');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, mode: FIXTURE ? 'fixture' : 'venice', tee: IN_TEE, active: active.size });
    // People's assistants (and the web app) upload here directly, from any site.
    if (path === '/summaries') {
      if (req.method === 'OPTIONS') return send(res, 204, null, CORS);
      if (req.method === 'POST') return send(res, 200, await sealUpload(req.headers.authorization, () => readBody(req, 64 * 1024)), CORS);
      return send(res, 405, { error: { code: 'method', message: 'Use POST.' } }, CORS);
    }
    // Reclaim posts a finished Codex usage proof here (and fixture mode's stand-in page completes one).
    if (req.method === 'POST' && path === '/proofs/callback') return send(res, 200, await proofCallback(url.searchParams.get('session'), req.headers['x-reclaim-session-id'], () => readBody(req, 512 * 1024)));
    if (req.method === 'GET' && path === '/proofs/fixture' && FIXTURE) return await fixtureProof(res, url.searchParams.get('session'));
    if (req.method === 'POST' && path.startsWith('/jobs/')) {
      if (!authorized(req.headers.authorization)) return send(res, 401, { error: { code: 'unauthorized', message: 'Missing or wrong service secret.' } });
      const body = await readBody(req, 512 * 1024);
      if (path === '/jobs/render') return send(res, 202, { accepted: true, joined: !start(parseJob(body)) });
      if (path === '/jobs/match') return send(res, 200, await match(body));
      if (path === '/jobs/drop') return send(res, 200, dropCard(body));
      if (path === '/jobs/auction') return send(res, 200, await auction(body));
      if (path === '/jobs/proof') return send(res, 200, await startProof(body));
      if (path === '/jobs/forget') return send(res, 200, { forgotten: forget(Array.isArray(body?.keys) ? body.keys : [], body?.at) });
      if (path === '/jobs/sealed') return send(res, 200, { sealed: (Array.isArray(body?.keys) ? body.keys : []).filter((key) => SUMMARY_KEY.test(key) && openSummary(key)) });
      // Whether a card's media is still kept here, so a re-render needs no new purchase.
      if (path === '/jobs/media') return send(res, 200, { kept: CARD_ID.test(body?.card_id ?? '') && ['hero.png', 'orbit.mp4'].every((file) => existsSync(join(CARDS, body.card_id, file))) });
    }
    send(res, 404, { error: { code: 'not_found', message: 'No such endpoint.' } });
  } catch (error) {
    const status = error.status ?? 500;
    if (status === 500) console.error(redact(error.stack ?? error));
    send(res, status, { error: { code: error.code ?? (status === 500 ? 'internal' : 'bad_request'), message: status === 500 ? 'Something went wrong.' : error.message } }, CORS);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ZKAds render service on ${HOST}:${PORT} (${FIXTURE ? `fixture media from ${FIXTURE}` : 'Venice'}, sound from the ${SOUND === 'music' ? 'music' : 'video'} model${IN_TEE ? ', in a TEE' : ', not in a TEE'}), reporting to ${WORKER_URL}`);
  if (FIXTURE) console.log('Fixture mode is for tests only: its stand-in matcher reveals words from summaries. Never run it with real people.');
  const sweep = () => {
    sweepSummaries();
    sweepCards();
  };
  sweep();
  setInterval(sweep, 10 * 60_000).unref();
  resumeUnfinished();
});

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400' };

// A render job carries either a finished concept (written by the person's own
// assistant) or `write`, telling the enclave to write the concept here: from
// sealed summaries ({ kind: 'fusion', people: [{ summary_key, card, name } ×2] }
// or { kind: 'summary', summary_key, artist?, era? }), or from an item in an
// earlier card's catalogue ({ kind: 'catalogue', card, item }).
function parseJob(body) {
  if (!CARD_ID.test(body?.card_id ?? '')) throw httpError(400, 'card_id is not a card id.');
  if (!JOB_TOKEN.test(body.token ?? '')) throw httpError(400, 'token is not a job token.');
  const job = {
    card_id: body.card_id,
    token: body.token,
    name: plainText(body.name, 80) || null,
    site: /^https?:\/\/[^\s"'<>`$]+$/.test(body.site ?? '') ? body.site : null,
    sponsor: cleanSponsor(body.sponsor),
    badge: cleanBadge(body.badge),
    // A re-render (to add a sponsored item, say) must never buy media again.
    reuse: body.reuse === true,
  };
  // A badge claiming a proof is shown only if this enclave verified that
  // proof; one from logs is rebuilt here from the numbers, label included.
  if (job.badge && job.badge.source !== 'logs') job.badge = provedBadge(job.card_id);
  else if (job.badge) job.badge = badgeFromStats(cleanStats(body.usage) ?? {});
  try {
    if (body.write) {
      const write = parseWrite(body.write);
      // A summary card is written only from the draft uploaded for that card.
      if (write.kind === 'summary' && write.summary_key !== `draft:${job.card_id}`) badRequest('A summary card is written from its own draft summary.');
      return { ...job, write };
    }
    return { ...job, concept: validateConcept(body.concept, { stored: true }) };
  } catch (error) {
    throw httpError(400, error.message);
  }
}

// A card its owner deleted: its summaries (with a fused card's own, `keys`)
// and pending proofs go now, and its folder (media, pages, records) and proof
// too, or as soon as a run still going on it ends (the worker refuses its
// next report, which stops it).
const dropped = new Set();
function dropCard(body) {
  if (!CARD_ID.test(body?.card_id ?? '')) throw httpError(400, 'card_id is not a card id.');
  const id = body.card_id;
  const own = (Array.isArray(body.keys) ? body.keys : []).filter((key) => typeof key === 'string' && key.startsWith('fusion:'));
  forget([`card:${id}`, `draft:${id}`, ...own], body.at);
  for (const [session, pending] of proofs) if (pending.card_id === id) proofs.delete(session);
  if (active.has(id)) dropped.add(id);
  else removeCard(id);
  return { dropped: true };
}

function removeCard(id) {
  try {
    rmSync(join(CARDS, id), { recursive: true, force: true });
    // Its proof only mattered for re-renders, which need the media just removed.
    rmSync(join(PROOFS, `${id}.json`), { force: true });
  } catch (error) {
    console.error(`[${short(id)}] could not remove: ${redact(describe(error))}`);
  }
}

function parseWrite(write) {
  const key = (value) => (value == null ? null : SUMMARY_KEY.test(value) ? value : badRequest('summary_key is not a summary key.'));
  const owner = (value) => (typeof value === 'string' && value.length <= 80 ? value : null);
  if (write.kind === 'fusion') {
    if (!Array.isArray(write.people) || write.people.length !== 2) badRequest('A fusion needs two people.');
    return { kind: 'fusion', people: write.people.map((p) => ({ summary_key: key(p?.summary_key), owner: owner(p?.owner), card: p?.card ? validateConcept(p.card, { stored: true }) : null, name: displayName(p?.name) || null })) };
  }
  if (write.kind === 'summary') return { kind: 'summary', summary_key: key(write.summary_key) ?? badRequest('summary_key is required.'), owner: owner(write.owner), artist: plainText(write.artist, 48) || null, era: ['scifi', 'historical'].includes(write.era) ? write.era : 'any' };
  if (write.kind === 'catalogue') {
    const item = { name: plainText(write.item?.name, 48), era: plainText(write.item?.era, 48), teaser: plainText(write.item?.teaser, 120) };
    if (!item.name || !item.era) badRequest('A catalogue item needs a name and an era.');
    return { kind: 'catalogue', card: validateConcept(write.card, { stored: true }), item };
  }
  return badRequest('write.kind must be fusion, summary or catalogue.');
}

// Starts a job unless one for the same card is running; that one adopts the
// newest token, since the worker only accepts the latest.
function start(job) {
  const dir = join(CARDS, job.card_id);
  mkdirSync(dir, { recursive: true });
  // A concept this enclave wrote stays as written (the page credits the enclave for it).
  if (job.concept && readRun(dir).concept?.source !== 'enclave') writeJson(join(dir, 'concept.json'), job.concept);
  if (!readRun(dir).created) {
    updateRun(dir, {
      created: new Date().toISOString(),
      input: { source: job.write ? 'enclave' : 'agent', name: job.name },
      ...(job.concept ? { concept: { model: 'your own assistant', source: 'import' } } : {}),
    });
  }
  const running = active.get(job.card_id);
  if (running) {
    // A re-render with new content (a sponsored item, a badge) must not be
    // answered with the page the running job already made.
    const changed = job.reuse || JSON.stringify([job.sponsor ?? null, job.badge ?? null]) !== JSON.stringify([running.sponsor ?? null, running.badge ?? null]);
    // The newest job's content wins outright (a refunded sponsor must not
    // linger, and a retry's summaries are the ones still allowed).
    Object.assign(running, { sponsor: job.sponsor ?? null, badge: job.badge ?? null, write: job.write ?? running.write, reuse: Boolean(running.reuse || job.reuse), ...(changed ? { rerun: true } : {}) });
  }
  saveJob(dir, { card_id: job.card_id, token: job.token, name: job.name, site: job.site ?? null, sponsor: job.sponsor ?? null, badge: job.badge ?? null, reuse: job.reuse ?? false, write: job.write ?? null, state: 'active' });
  if (running) {
    running.token = job.token;
    return false;
  }
  const state = { card_id: job.card_id, token: job.token, name: job.name, site: job.site ?? null, sponsor: job.sponsor ?? null, badge: job.badge ?? null, reuse: job.reuse ?? false, write: job.write ?? null };
  active.set(job.card_id, state);
  renderCard(state, dir)
    .catch((error) => console.error(`[${short(job.card_id)}] ${redact(describe(error))}`))
    .finally(() => {
      active.delete(job.card_id);
      // Deleted while it ran: its folder goes now.
      if (dropped.delete(job.card_id)) removeCard(job.card_id);
    });
  return true;
}

// Logs name cards by a short prefix: the full id is what opens a card's page.
function short(id) {
  return id.slice(0, 6);
}

// Error text can carry full card ids (in file paths, say); logs never do.
function redact(text) {
  return String(text).replace(/[a-z2-7]{20}/g, (id) => `${id.slice(0, 6)}…`);
}

async function renderCard(job, dir) {
  const log = (message) => console.log(`[${short(job.card_id)}] ${redact(String(message).trim())}`);
  for (;;) {
    const startedWith = job.token;
    // New content arriving from here on (a newer job) means one more pass.
    job.rerun = false;
    const outcome = await renderOnce(job, dir, log);
    // A newer job arrived during this run: after a failure, an admin retry
    // deserves its own run; after a finished page, new content (a sponsor, a
    // badge) needs a new one. Either way nothing about this run is reported
    // or saved. (A cancelled run just stops.)
    if (job.token !== startedWith && (outcome.failed || (outcome.files && job.rerun))) continue;
    if (outcome.failed) {
      if ((await finish(job, dir, { status: 'failed', error: outcome.error }, log, startedWith)) === 'rerender') continue;
      return undefined;
    }
    if (outcome.files) {
      // "ready" names the badge the page now shows, so the worker can tell the person.
      const report = { status: 'ready', files: outcome.files, badge: job.badge ?? null, ...enclaveConcept(job, dir) };
      if ((await finish(job, dir, report, log, startedWith)) === 'rerender') continue;
      return undefined;
    }
    return undefined;
  }
}

// A concept the enclave wrote travels with "ready" too, so the worker has it
// even if the progress report that carried it was lost.
function enclaveConcept(job, dir) {
  return job.write && readRun(dir).concept?.source === 'enclave' ? { concept: readConcept(dir) } : {};
}

async function renderOnce(job, dir, log) {
  let step = 'queued';
  let cancelled = null;
  const stop = (error) => Object.assign(new Error(`the worker cancelled this job (${error.status})`), { cancelled: true, token: error.token });
  // A refusal counts only while the refused token is still the job's: a
  // retry adopted since then deserves its run.
  const live = () => cancelled && cancelled.token === job.token;
  // Reported before each step. If the worker refuses (the card failed, was
  // refunded or handed to a newer job), stop before paying for anything more;
  // if it is merely unreachable, carry on.
  const progress = async (next, extra = {}) => {
    if (live()) throw cancelled;
    step = next;
    try {
      await toWorker(job, 'status', { body: { status: 'rendering', step, ...extra } });
    } catch (error) {
      if (error.refused) throw stop(error);
      log(`could not report progress: ${describe(error)}`);
    }
  };
  // A heartbeat every five minutes, so a job waiting for a slot or a slow
  // Venice queue is not taken for dead (the worker fails silent cards).
  const heartbeat = setInterval(() => {
    toWorker(job, 'status', { body: step === 'queued' ? { status: 'queued' } : { status: 'rendering', step } }).catch((error) => {
      if (error.refused) cancelled = stop(error);
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    // A concept the enclave already wrote is kept, so a retry never pays twice.
    if (job.write && !(existsSync(join(dir, 'concept.json')) && readRun(dir).concept?.source === 'enclave')) {
      await progress('concept');
      await writeConcept(job, dir, log);
      // The worker keeps the finished concept (never the summaries) for the record and retries.
      await progress('image', { concept: readConcept(dir) });
    }
    if (job.reuse) {
      // A re-render (a badge or sponsored item added) never buys media, music included.
      if (!['hero.png', 'orbit.mp4'].every((file) => existsSync(join(dir, file)))) throw new Error('this card’s media is no longer kept here, so it cannot be re-rendered without paying again');
    } else {
      await mediaSlot(() => (FIXTURE ? useFixture(dir) : makeMedia({ venice, dir, models: MODELS, seconds: ORBIT_SECONDS, sound: SOUND, progress, log })));
    }
    await progress('page');
    updateRun(dir, { attested: IN_TEE });
    const files = await pageSlot(async () => {
      rmSync(join(dir, 'attestation.json'), { force: true });
      await renderShare({ dir, concept: readConcept(dir), run: readRun(dir), name: job.name ?? undefined, log, site: job.site, card: job.card_id, sponsor: job.sponsor, badge: job.badge });
      const rendered = Object.keys(CARD_FILES).filter((file) => existsSync(join(dir, file)));
      const attested = await attestCard(dir, job.card_id, rendered, log, job.badge);
      return attested ? [...rendered, attested] : rendered;
    });
    if (live()) throw cancelled;
    return { files };
  } catch (error) {
    if (error.cancelled) {
      log(`stopped: ${error.message}`);
      trySaveJob(dir, { ...job, state: 'cancelled' }, log);
      return {};
    }
    log(`failed at ${step}: ${describe(error)}`);
    // Details stay in this log; the card's public status names the step only.
    return { failed: true, error: publicError(step) };
  } finally {
    clearInterval(heartbeat);
  }
}

// The last word must reach the worker: a finished card's files and "ready",
// or "failed". Until it is acknowledged it stays in job.json, and it is sent
// again every two minutes for an hour and after a restart.
// Returns 'rerender' when a failure report is overtaken by an admin retry
// (a new token): the retry deserves a fresh attempt, not the old failure.
async function finish(job, dir, report, log, decidedWith = job.token) {
  trySaveJob(dir, { ...job, state: report.status === 'ready' ? 'publishing' : 'reporting', files: report.files, report }, log);
  // A failure is overtaken by any newer token (an admin retry); a finished
  // page is overtaken only by a newer job asking for different content.
  const overtaken = () => job.token !== decidedWith && (report.status === 'failed' || job.rerun);
  for (let attempt = 1; ; attempt++) {
    if (overtaken()) return 'rerender';
    try {
      if (report.status === 'failed') {
        // A failure goes out only under the token it was decided with, never a
        // newer one, and stops trying the moment a newer job takes over.
        await toWorker(job, 'status', { body: report, token: decidedWith, abortIf: overtaken });
      } else {
        await underNewestToken(job, async () => {
          // The page goes last, so it never appears before its media.
          for (const file of [...report.files].sort((a, b) => (a === 'index.html') - (b === 'index.html'))) {
            if (overtaken()) return job.token;
            await toWorker(job, `files/${file}`, { method: 'PUT', body: readFileSync(join(dir, file)), type: CARD_FILES[file], abortIf: overtaken });
          }
          if (overtaken()) return job.token;
          // Retries inside toWorker stop too once a newer job wants different content.
          return toWorker(job, 'status', { body: report, abortIf: overtaken });
        });
      }
      if (overtaken()) return 'rerender';
      trySaveJob(dir, { ...job, state: report.status === 'ready' ? 'done' : 'failed' }, log);
      if (report.status === 'ready') prune(dir);
      log(report.status);
      return report.status;
    } catch (error) {
      if (error.refused && overtaken()) return 'rerender';
      if (error.refused) {
        trySaveJob(dir, { ...job, state: 'refused' }, log);
        log(`the worker refused the ${report.status} report: ${describe(error)}`);
        return 'refused';
      }
      if (attempt >= 30) {
        log(`still could not deliver the ${report.status} report; it will be sent again after a restart`);
        return 'undelivered';
      }
      log(`could not deliver the ${report.status} report yet (${describe(error)}); trying again in two minutes`);
      for (let waited = 0; waited < 120 && !overtaken(); waited++) await sleep(1000);
    }
  }
}

// Runs `send` (which returns the token its last call went out under) until
// that token is the job's newest: an admin retry handing the job a new token
// meanwhile gets everything again. A refusal just after such a retry (the
// old token retired, the new one not here yet) waits briefly for it.
async function underNewestToken(job, send) {
  for (;;) {
    const before = job.token;
    let used;
    try {
      used = await send();
    } catch (error) {
      if (!error.refused) throw error;
      const deadline = Date.now() + 10_000;
      while (job.token === before && Date.now() < deadline) await sleep(250);
      if (job.token === before) throw error;
      continue;
    }
    if (used === job.token) return;
  }
}

// Inside a Phala CVM, each finished card gets a TDX quote whose report data
// is the SHA-256 of a statement naming the card and its files' hashes, so
// anyone can check that this attested build made exactly these files.
async function attestCard(dir, cardId, files, log, badge) {
  if (!IN_TEE) return null;
  try {
    const { DstackClient } = await import('@phala/dstack-sdk');
    const client = new DstackClient();
    // A proved badge names the proof behind it, so the quote vouches for that too.
    const proof = badge && badge.source !== 'logs' ? readProof(cardId) : null;
    const statement = {
      card_id: cardId,
      files: Object.fromEntries(files.map((file) => [file, digest(readFileSync(join(dir, file)))])),
      ...(proof ? { badge: { value: badge.value, label: badge.label, source: proof.source, provider_id: proof.provider_id, provider_version: proof.provider_version ?? null, proof_session: proof.reclaim_session } } : {}),
    };
    const reportData = createHash('sha256').update(JSON.stringify(statement)).digest();
    const [quote, info] = await Promise.all([client.getQuote(reportData), client.info()]);
    writeJson(join(dir, 'attestation.json'), {
      statement,
      report_data: reportData.toString('hex'),
      quote: quote.quote,
      event_log: quote.event_log,
      app_id: info.app_id,
      compose_hash: info.compose_hash ?? info.tcb_info?.compose_hash ?? null,
      how_to_verify: 'Check the quote at https://proof.t16z.com (Phala’s TEE attestation explorer); its report data must equal the SHA-256 of the JSON statement above, and the files must hash to the values it lists.',
    });
    return 'attestation.json';
  } catch (error) {
    log(`could not attest the card: ${describe(error)}`);
    // No quote, so no link to one.
    const page = join(dir, 'index.html');
    if (existsSync(page)) writeFileSync(page, readFileSync(page, 'utf8').replace(/<p><a href="attestation\.json">[^<]*<\/a><\/p>/, ''));
    return null;
  }
}

// The proved badge for a card, from the proof this enclave verified (or, in
// fixture mode, the stand-in), never from what a job claims.
function provedBadge(cardId) {
  const proof = readProof(cardId);
  return proof ? cleanBadge({ value: formatCount(proof.tokens), label: 'Codex tokens', source: proof.source }) : null;
}

function readProof(cardId) {
  try {
    return readJson(join(PROOFS, `${cardId}.json`));
  } catch {
    return null;
  }
}

function saveProof(record) {
  mkdirSync(PROOFS, { recursive: true });
  writeJson(join(PROOFS, `${record.card_id}.json`), record, { mode: 0o600 });
}

const STEP_NAMES = { queued: 'start', concept: 'concept', image: 'image', orbit: '360° orbit', music: 'music', page: 'page', upload: 'upload' };

function publicError(step) {
  return `Rendering stopped at the ${STEP_NAMES[step] ?? step} step. ZKAds can retry it.`;
}

// After a card is ready its page and videos live in R2, so only what a retry
// needs stays here: the hero, orbit, music, concept and records.
function prune(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'layers' || Object.hasOwn(CARD_FILES, name) || /^hero\..+\.png$/.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

// Writes the card's concept with the confidential model, in this process. A
// card from one summary is written from that summary; a fusion from each
// person's card and the profile a model wrote from their summary alone, so
// the two summaries never meet in one prompt. Summaries uploaded for this one
// card (a fusion's, or a draft's) are deleted once it has its concept.
async function writeConcept(job, dir, log) {
  const { kind } = job.write;
  let request;
  let people = [];
  if (kind === 'catalogue') {
    // Public card text only: written by Venice, not the confidential model.
    let concept;
    let record;
    if (FIXTURE) {
      concept = fixtureConcept(kind, [], job.write);
      record = { model: 'fixture writer' };
    } else {
      log(`writing the catalogue card with ${MODELS.text}…`);
      const spec = await venice.model('text', MODELS.text);
      const supportsSchema = Boolean(spec.model_spec?.capabilities?.supportsResponseSchema);
      const request = buildCatalogueRequest({ card: job.write.card, item: job.write.item, name: job.name, supportsSchema });
      const { reply, concept: written } = await askForConcept((user) => venice.chat({ model: MODELS.text, system: request.system, user, schema: supportsSchema ? CONCEPT_SCHEMA : undefined }), request.user);
      concept = written;
      record = { model: MODELS.text, usage: reply.usage };
    }
    writeJson(join(dir, 'concept.json'), concept);
    updateRun(dir, { concept: { source: 'enclave', kind, tee: IN_TEE, summaries: 0, ...record } });
    return;
  }
  if (kind === 'fusion') {
    // A summary is used only for the person who sealed it, and a profile
    // only if its summary is still the one profiled. A profile that fails (or
    // whose summary was withdrawn or replaced meanwhile) is tried once more,
    // with the summary sealed by then.
    people = await Promise.all(
      job.write.people.map(async (person) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const sealed = person.summary_key ? ownSummary(person.summary_key, person.owner) : null;
          if (!sealed) return { ...person, profile: null };
          const profile = await profileOf(sealed).catch((error) => {
            // A second failure counts only while this summary is still the one sealed.
            if (attempt >= 2 && ownSummary(person.summary_key, person.owner)?.seal_id === sealed.seal_id) throw error;
            return null;
          });
          if (profile && ownSummary(person.summary_key, person.owner)?.seal_id === sealed.seal_id) return { ...person, profile, seal_id: sealed.seal_id };
        }
        // Withdrawn meanwhile: fused without it, as if it had never been sealed.
        if (!ownSummary(person.summary_key, person.owner)) return { ...person, profile: null };
        throw new Error('the summary changed while the fusion was being written');
      }),
    );
    if (!people.some((person) => person.profile || person.card)) throw new Error('Neither person has a summary or a card to fuse.');
    request = buildFusionRequest(people);
  } else {
    const sealed = ownSummary(job.write.summary_key, job.write.owner);
    if (!sealed) throw new Error('The sealed summary expired or was never uploaded.');
    request = { ...buildConceptRequest({ history: sealed.summary, artist: job.write.artist, era: job.write.era, name: job.name }), schema: CONCEPT_SCHEMA };
  }
  let concept;
  let record;
  if (FIXTURE) {
    concept = fixtureConcept(kind, people);
    record = { model: 'fixture writer', receipt: null };
  } else {
    log(`writing the ${kind} concept with ${MODELS.concept}…`);
    // A call (or its one retry) is skipped if a summary it uses was withdrawn
    // (with its deleted card, say) or, for a fusion, replaced while it waited.
    const stillSealed = kind === 'summary' ? () => Boolean(ownSummary(job.write.summary_key, job.write.owner)) : () => people.every((person) => !person.seal_id || ownSummary(person.summary_key, person.owner)?.seal_id === person.seal_id);
    const { reply, concept: written } = await askForConcept((user) => chat({ model: MODELS.concept, system: request.system, user, schema: request.schema }, stillSealed), request.user);
    concept = written;
    record = { model: reply.model, receipt: reply.receipt, usage: reply.usage };
  }
  writeJson(join(dir, 'concept.json'), concept);
  updateRun(dir, { concept: { source: 'enclave', kind, tee: IN_TEE, summaries: people.filter((p) => p.profile).length || (kind === 'summary' ? 1 : 0), ...record } });
  const used = kind === 'fusion' ? job.write.people.map((person) => person.summary_key) : [job.write.summary_key];
  forget(used.filter((key) => /^(fusion|draft):/.test(key ?? '')));
}

// Fixture mode's stand-in for the model: a fusion blends the two cards; a
// catalogue card renames the earlier one after its item; a summary card
// reuses the fixture's concept.
function fixtureConcept(kind, people, write = null) {
  if (kind === 'catalogue') return validateConcept({ ...write.card, product_name: write.item.name, era: write.item.era });
  if (kind === 'fusion') {
    const [a, b] = people.map((person) => person.card ?? readJson(join(FIXTURE, 'concept.json')));
    return validateConcept({
      ...a,
      product_name: plainText(`${a.product_name} × ${b.product_name}`, 48),
      archetype: 'The Fused Pair',
      reading: 'Two collections, one shared shelf.',
      reasons: [a.reasons[0], b.reasons[0], a.reasons[1] ?? b.reasons[1]].filter(Boolean),
    });
  }
  return validateConcept({ ...readJson(join(FIXTURE, 'concept.json')), product_name: 'The Summary Special' });
}

// find_fusion_partner, the enclave's way: rank the pool by the interest tags
// in the profile each sealed summary yielded on its own. Plain code, no
// model: a reason names only tags both people share.
async function match(body) {
  const me = SUMMARY_KEY.test(body?.key ?? '') && ownSummary(body.key, body.owner);
  if (!me) throw Object.assign(httpError(409, 'Seal a summary for this card before looking for partners.'), { code: 'no_summary' });
  if (!me.profile && recentlyFailed(me)) throw unreadableError(me);
  const candidates = (Array.isArray(body.pool) ? body.pool : [])
    .filter((key) => SUMMARY_KEY.test(key) && key.startsWith('card:') && key !== body.key)
    .map((key) => ({ key, record: openSummary(key) }))
    .filter((candidate) => candidate.record);
  if (!candidates.length) return { matches: [] };
  const mine = (await profileOf(me).catch(() => Promise.reject(unreadableError(me)))).tags;
  // Summaries without a profile get one, a few per search; one that cannot
  // be profiled is skipped (and not tried again by searches for five
  // minutes), never fatal for everyone else's search.
  let budget = 8;
  const results = await Promise.allSettled(candidates.map((c) => (c.record.profile ? c.record.profile : !recentlyFailed(c.record) && budget-- > 0 ? profileOf(c.record) : Promise.reject(new Error('later')))));
  // Only summaries still sealed as they were profiled (none withdrawn or replaced meanwhile).
  const pool = candidates.flatMap((c, i) => (results[i].status === 'fulfilled' && openSummary(c.key)?.seal_id === c.record.seal_id ? [{ key: c.key, tags: results[i].value.tags }] : []));
  // Partners and reasons only: the score stays here (it would hint at overlap the reason does not name).
  return { matches: rankByTags({ key: body.key, tags: mine }, pool).map(({ key, reason }) => ({ key, reason })) };
}

// A summary's profile ({ tags, traits }), worked out once (alone, by the
// model) and kept with it: one call per seal, however many ask at once.
// Failures are noted: searches leave a summary alone for five minutes after
// any, and for good after its third unusable answer (an outage at the model
// provider never counts toward that).
const profiling = new Map();
const profileFailed = new Map();
const PROFILE_RETRY_MS = 5 * 60_000;
const sealOf = (record) => record.seal_id ?? `${record.key}:${record.sealed_at}`;

function unreadable(record) {
  return (profileFailed.get(sealOf(record))?.count ?? 0) >= 3;
}

// What a searcher hears when their own summary has no profile to search with.
function unreadableError(record) {
  return unreadable(record)
    ? Object.assign(httpError(409, 'This summary could not be read. Seal a new one.'), { code: 'summary_unreadable' })
    : Object.assign(httpError(409, 'This summary could not be read just now. Try again in a few minutes, or seal a new one.'), { code: 'profile_failed' });
}

function recentlyFailed(record) {
  return unreadable(record) || profileFailed.get(sealOf(record))?.at > Date.now() - PROFILE_RETRY_MS;
}

function profileOf(record) {
  if (record.profile) return Promise.resolve(record.profile);
  const id = sealOf(record);
  if (!profiling.has(id)) {
    const work = profileSummary(record).catch((error) => {
      const now = Date.now();
      // Noted no longer than a summary can live.
      for (const [key, failed] of profileFailed) if (failed.at <= now - SUMMARY_HOURS_MAX * 3_600_000) profileFailed.delete(key);
      profileFailed.set(id, { at: now, count: (profileFailed.get(id)?.count ?? 0) + (error.unusable ? 1 : 0) });
      throw error;
    });
    profiling.set(id, work.finally(() => profiling.delete(id)));
  }
  return profiling.get(id);
}

async function profileSummary(record) {
  let profile;
  if (FIXTURE) profile = fixtureProfile(record.summary);
  else {
    const request = buildProfileRequest(record.summary);
    // Skipped if the person replaced or withdrew this summary while it waited.
    const stillSealed = () => openSummary(record.key)?.seal_id === record.seal_id;
    const reply = await chat({ model: MODELS.match, system: request.system, user: request.user, schema: request.schema, maxTokens: 1200 }, stillSealed);
    try {
      profile = cleanProfile(extractJson(reply.content), record.summary);
    } catch (error) {
      // The model answered, but not with a usable profile: this summary's own doing.
      throw Object.assign(error, { unusable: true });
    }
  }
  profile = { ...profile, tags: [...profile.tags, ...usageTags(record.usage)] };
  // Only onto the same seal: the person may have replaced or withdrawn it meanwhile.
  const current = openSummary(record.key);
  if (current && current.seal_id === record.seal_id && current.sealed_at === record.sealed_at) writeJson(summaryPath(record.key), { ...current, profile }, { mode: 0o600 });
  return profile;
}

// The sealed auction for one card's sponsored slot. Fit scores and losing
// bids stay here; only the winner, its price and its item go back.
async function auction(body) {
  let concept;
  try {
    concept = validateConcept(body?.concept, { stored: true });
  } catch (error) {
    throw httpError(400, error.message);
  }
  const brands = (Array.isArray(body.brands) ? body.brands : [])
    .slice(0, 100)
    .filter((b) => typeof b?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(b.id) && Number.isInteger(b.bid) && b.bid >= 1 && b.bid <= 100)
    .map((b) => ({ id: b.id, bid: b.bid, name: plainText(b.name, 40), product: plainText(b.product, 80), tagline: plainText(b.tagline, 80), targets: (Array.isArray(b.targets) ? b.targets : []).map((t) => plainText(t, 30)).filter(Boolean).slice(0, 8) }));
  if (!brands.length) return { winner: null };
  // Fit is worked out in code from the card's own text (no summary), and no
  // model reads the brands' text together.
  const result = runAuction(brands, fitsFromCard({ concept, brands }));
  if (!result) return { winner: null };
  let item;
  if (FIXTURE) item = cleanItem({ name: `${result.brand.name}, ${concept.era} edition`, era: concept.era, teaser: result.brand.tagline }, concept);
  else {
    const request = buildItemRequest({ concept, brand: result.brand });
    const reply = await chat({ model: MODELS.concept, system: request.system, user: request.user, schema: request.schema, maxTokens: 2000 });
    item = cleanItem(extractJson(reply.content), concept);
  }
  return { winner: { brand_id: result.brand.id, price: result.price }, item };
}

// Opens a Reclaim proof session for a card's Codex usage. Its request URL
// opens Popcorn (Reclaim's remote browser, itself in a TEE), where the person
// signs in to ChatGPT and the usage page is proved; Reclaim then posts the
// proof to /proofs/callback here.
async function startProof(body) {
  if (!CARD_ID.test(body?.session ?? '') || !CARD_ID.test(body.card_id ?? '') || !/^https?:\/\/[^\s"'<>]+$/.test(body.callback_base ?? '')) throw httpError(400, 'session, card_id and callback_base are required.');
  const base = body.callback_base.replace(/\/+$/, '');
  for (const [key, value] of proofs) if (value.expires_at <= Date.now()) proofs.delete(key);
  if (FIXTURE) {
    proofs.set(body.session, { card_id: body.card_id, expires_at: Date.now() + 30 * 60_000 });
    return { request_url: `${base}/proofs/fixture?session=${body.session}` };
  }
  if (!RECLAIM.appId || !RECLAIM.appSecret || !RECLAIM.providerId || !RECLAIM.providerVersion) throw httpError(503, 'Codex proofs are not set up yet (RECLAIM_APP_ID, RECLAIM_APP_SECRET, RECLAIM_PROVIDER_ID, RECLAIM_PROVIDER_VERSION).');
  const { ReclaimProofRequest } = await import('@reclaimprotocol/js-sdk');
  const request = await ReclaimProofRequest.init(RECLAIM.appId, RECLAIM.appSecret, RECLAIM.providerId, { providerVersion: RECLAIM.providerVersion });
  if (request.getProviderVersion().providerVersion !== RECLAIM.providerVersion) throw httpError(503, 'Reclaim did not open the pinned provider version.');
  request.setAppCallbackUrl(`${base}/proofs/callback?session=${body.session}`, true);
  request.setJsonContext({ zkads_session: body.session });
  const requestUrl = await request.getRequestUrl();
  proofs.set(body.session, { card_id: body.card_id, reclaim_session: request.getSessionId(), expires_at: Date.now() + 30 * 60_000 });
  return { request_url: requestUrl };
}

// Reclaim's callback: the proof is checked here (signatures, the attestor's
// TEE attestation, the provider's hashes), bound to the session this enclave
// opened, used once, and only the token count goes to the worker.
// (The body is read only once the session checks out.)
async function proofCallback(session, reclaimSession, readBodyOf) {
  const pending = CARD_ID.test(session ?? '') && proofs.get(session);
  if (!pending || pending.expires_at <= Date.now() || FIXTURE) throw httpError(404, 'No such proof session.');
  if (reclaimSession && reclaimSession !== pending.reclaim_session) throw httpError(400, 'This proof belongs to another session.');
  const body = await readBodyOf();
  const proof = Array.isArray(body) ? body[0] : body;
  if (!proof) throw httpError(400, 'No proof was sent.');
  const { verifyProof } = await import('@reclaimprotocol/js-sdk');
  // Checked against the pinned provider version, never one the session names.
  const result = await verifyProof(proof, { providerId: RECLAIM.providerId, providerVersion: RECLAIM.providerVersion, allowedTags: [], ...(RECLAIM.requireTee ? { teeAttestation: { appSecret: RECLAIM.appSecret } } : {}) });
  const data = result.data?.[0];
  if (!result.isVerified || data?.context?.reclaimSessionId !== pending.reclaim_session || data?.context?.zkads_session !== session) {
    proofs.delete(session);
    await reportProof(session, { status: 'failed', error: 'The proof did not verify.' });
    throw httpError(400, 'The proof did not verify.');
  }
  // A plain whole number, optionally with thousands separators; anything else is refused.
  const raw = String(data.extractedParameters?.[RECLAIM.tokensParam] ?? '').trim();
  const tokens = /^\d{1,3}(,\d{3})*$|^\d+$/.test(raw) ? Number(raw.replace(/,/g, '')) : NaN;
  // Gone meanwhile: its card was deleted while the proof was checked.
  if (!proofs.delete(session)) throw httpError(404, 'No such proof session.');
  if (!(tokens > 0 && tokens <= 1e13)) {
    await reportProof(session, { status: 'failed', error: 'The proof did not include a usable token count.' });
    throw httpError(400, 'The proof did not include a usable token count.');
  }
  saveProof({ card_id: pending.card_id, tokens, source: 'zktls', provider_id: RECLAIM.providerId, provider_version: RECLAIM.providerVersion, reclaim_session: pending.reclaim_session, verified_at: Date.now() });
  await reportProof(session, { status: 'verified', tokens, source: 'zktls' });
  return { ok: true };
}

// Fixture mode: opening the "request URL" completes the proof with a fixed count.
async function fixtureProof(res, session) {
  const pending = CARD_ID.test(session ?? '') && proofs.get(session);
  if (!pending) return send(res, 404, { error: { code: 'not_found', message: 'No such proof session.' } });
  proofs.delete(session);
  saveProof({ card_id: pending.card_id, tokens: FIXTURE_CODEX_TOKENS, source: 'fixture', provider_id: 'fixture', reclaim_session: null, verified_at: Date.now() });
  await reportProof(session, { status: 'verified', tokens: FIXTURE_CODEX_TOKENS, source: 'fixture' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" });
  res.end('<!doctype html><meta charset="utf-8"><title>ZKAds fixture proof</title><p>Fixture proof sent. You can close this page.</p>');
}

// The verdict on a proof, to the worker, retried while it is unreachable.
async function reportProof(session, result) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/internal/proofs/${session}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
      if (res.status < 500 || attempt >= 5) throw Object.assign(new Error(`The worker refused the proof result (${res.status}).`), { final: true });
    } catch (error) {
      if (error.final || attempt >= 5) throw error;
    }
    await sleep(2000 * attempt);
  }
}

// Sealed summaries: one file per key on the data volume (which Phala encrypts
// with a key only this app's TEE can derive), deleted on expiry or request.
// card:<id> is a card's summary for matching; fusion:<id> and draft:<id> are
// uploaded for one fusion or one card's concept and deleted once it is written.
const SUMMARY_KEY = /^(card|fusion|draft):[a-z2-7]{20}$/;

function summaryPath(key) {
  return join(SUMMARIES, `${createHash('sha256').update(key).digest('hex')}.json`);
}

function openSummary(key) {
  const path = summaryPath(key);
  if (!existsSync(path)) return null;
  const record = readJson(path);
  if (record.expires_at <= Date.now()) {
    rmSync(path, { force: true });
    return null;
  }
  return record;
}

// A summary only for the person who sealed it.
function ownSummary(key, owner) {
  const record = openSummary(key);
  return record && owner && record.owner === owner ? record : null;
}

// Per key, when the last accepted upload link was issued and when the key was
// last forgotten: a link issued before either is refused. That makes links
// single-use across restarts and stops one from outliving "stop matching".
function markerPath(key) {
  return join(SUMMARIES, `${createHash('sha256').update(key).digest('hex')}.seal`);
}

function readMarker(key) {
  try {
    return readJson(markerPath(key));
  } catch {
    return {};
  }
}

// `at` is the worker's clock (the clock upload links are issued by), when
// it sends one that is plausible; otherwise this enclave's.
function forget(keys, at) {
  const now = Date.now();
  const when = Number.isFinite(at) && Math.abs(at - now) < 86_400_000 ? at : now;
  let count = 0;
  for (const key of keys) {
    if (!SUMMARY_KEY.test(key)) continue;
    mkdirSync(SUMMARIES, { recursive: true });
    writeJson(markerPath(key), { ...readMarker(key), forgotten_at: when, updated_at: now }, { mode: 0o600 });
    if (!existsSync(summaryPath(key))) continue;
    rmSync(summaryPath(key), { force: true });
    count++;
  }
  return count;
}

// Expired summaries go; markers go a day after their last use (upload links
// last 30 minutes). Anything unreadable is removed, anything unexpected skipped.
function sweepSummaries() {
  try {
    if (!existsSync(SUMMARIES)) return;
    const now = Date.now();
    for (const file of readdirSync(SUMMARIES)) {
      const path = join(SUMMARIES, file);
      try {
        if (!statSync(path).isFile()) continue;
        const record = readJson(path);
        const stale = file.endsWith('.seal') ? record.updated_at <= now - 86_400_000 : record.expires_at <= now;
        if (stale) rmSync(path, { force: true });
      } catch {
        rmSync(path, { force: true });
      }
    }
  } catch (error) {
    console.error(`could not sweep summaries: ${redact(describe(error))}`);
  }
}

// An upload token is zku.<payload>.<signature>: the worker signs
// { k: summary key, o: owner, iat, exp, ttl, n: nonce } with the shared
// secret, so the enclave can check it without asking the worker. Each works
// once (see markerPath), and only until its key is forgotten.
// (The body is read only once the token's signature checks out; whether the
// token is still fresh is checked and recorded together, after it arrives.)
async function sealUpload(header, readBodyOf) {
  const token = String(header ?? '').match(/^Bearer\s+(zku\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) throw Object.assign(httpError(401, 'Send the upload token from ZKAds as "Authorization: Bearer zku.…".'), { code: 'unauthorized' });
  const [, payload, signature] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw Object.assign(httpError(401, 'This upload token is not valid.'), { code: 'unauthorized' });
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(httpError(401, 'This upload token is not valid.'), { code: 'unauthorized' });
  }
  if (!SUMMARY_KEY.test(claims.k) || typeof claims.o !== 'string' || !(claims.exp > Date.now())) throw Object.assign(httpError(401, 'This upload token has expired or was already used. Ask ZKAds for a new one.'), { code: 'expired' });
  const body = await readBodyOf();
  const now = Date.now();
  const marker = readMarker(claims.k);
  const fresh = Number.isFinite(claims.iat) && claims.iat > (marker.last_iat ?? 0) && claims.iat > (marker.forgotten_at ?? 0);
  if (!(claims.exp > now) || !fresh) throw Object.assign(httpError(401, 'This upload token has expired or was already used. Ask ZKAds for a new one.'), { code: 'expired' });
  const summary = typeof body?.summary === 'string' ? body.summary.replace(/\r\n?/g, '\n').trim() : '';
  if (summary.length < 40) throw httpError(400, 'summary must be at least 40 characters of text.');
  if (summary.length > MAX_SUMMARY_CHARS) throw httpError(413, `summary must be at most ${MAX_SUMMARY_CHARS} characters.`);
  mkdirSync(SUMMARIES, { recursive: true });
  writeJson(markerPath(claims.k), { ...marker, last_iat: claims.iat, updated_at: now }, { mode: 0o600 });
  const hours = Math.min(SUMMARY_HOURS_MAX, Math.max(1, Number(claims.ttl) || SUMMARY_HOURS_MAX));
  const record = { key: claims.k, seal_id: randomUUID(), owner: claims.o, summary, usage: cleanStats(body.usage), sealed_at: now, expires_at: now + hours * 3_600_000 };
  writeJson(summaryPath(claims.k), record, { mode: 0o600 });
  // A card's summary gets its profile for matching in the background, alone;
  // if the model is unavailable, that happens at a later search instead. (A
  // fusion's is profiled when the fusion is written.)
  if (claims.k.startsWith('card:')) profileOf(record).catch((error) => console.error(`could not profile a summary yet: ${redact(describe(error))}`));
  return { sealed: true, key: claims.k, expires_at: new Date(record.expires_at).toISOString(), tee: IN_TEE };
}

// Copies the fixture's media in place of new Venice jobs; prices are dropped
// so the page shows no cost for media nobody paid for.
async function useFixture(dir) {
  // Tests can slow fixture renders down to see a card mid-render.
  if (env.ENCLAVE_FIXTURE_DELAY_MS) await sleep(Number(env.ENCLAVE_FIXTURE_DELAY_MS) || 0);
  const run = readRun(FIXTURE);
  const music = run.music?.status === 'done' && run.music.file && existsSync(join(FIXTURE, run.music.file)) ? run.music : null;
  for (const file of ['hero.png', 'orbit.mp4', music?.file].filter(Boolean)) copyFileSync(join(FIXTURE, file), join(dir, file));
  const free = (record) => (record ? { ...record, usd: undefined } : undefined);
  updateRun(dir, {
    fixture: true,
    image: free(run.image) ?? { model: 'fixture' },
    video: free(run.video) ?? { model: 'fixture', status: 'done' },
    orbit: { hero_sha256: digest(readFileSync(join(dir, 'hero.png'))), model: run.video?.model ?? 'fixture' },
    music: free(music),
  });
}

// Calls the worker's internal routes for this card, retrying while it is
// unreachable or busy; a refusal (wrong token, unknown card) is final.
// `token` pins the call to one token (a failure report); otherwise the job's
// newest token is used, and a refusal right after a handover is retried.
async function toWorker(job, path, { method = 'POST', body, type = 'application/json', token: pinned, abortIf = () => false } = {}) {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1 && abortIf()) throw Object.assign(new Error(`${path} was overtaken by a newer job`), { refused: true, overtaken: true });
    const token = pinned ?? job.token;
    let res;
    try {
      res = await fetch(`${WORKER_URL}/internal/cards/${job.card_id}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': type },
        body: payload,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (attempt >= 6) throw new Error(`Could not reach the worker (${describe(error)}).`);
      await sleep(1500 * attempt);
      continue;
    }
    if (res.ok) return token;
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    // A retry for this card handed the job a new token while this call was out.
    if (!pinned && (res.status === 401 || res.status === 403) && job.token !== token && attempt < 6) continue;
    if ((res.status >= 500 || res.status === 429) && attempt < 6) {
      await sleep(1500 * attempt);
      continue;
    }
    // Only answers about the job itself (wrong token, no such card, wrong
    // state) are refusals; a 400 or 413 is a bug here, not a cancellation.
    const refused = new Error(`The worker refused ${method} ${path} (${res.status}${detail ? `: ${detail}` : ''}).`);
    throw Object.assign(refused, { refused: [401, 403, 404, 409].includes(res.status), status: res.status, token });
  }
}

// Picks up jobs a restart interrupted; finished steps and paid jobs carry
// over. A card whose records are broken is skipped, never fatal.
function resumeUnfinished() {
  if (!existsSync(CARDS)) return;
  for (const id of readdirSync(CARDS)) {
    try {
      const path = join(CARDS, id, 'job.json');
      if (!CARD_ID.test(id) || !existsSync(path)) continue;
      const job = readJson(path);
      const dir = join(CARDS, id);
      if (job.state === 'publishing' || job.state === 'reporting') {
        // Rendering finished; only the last report still has to reach the worker.
        console.log(`[${short(id)}] delivering its ${job.report?.status ?? 'ready'} report after a restart`);
        const state = { card_id: job.card_id, token: job.token, name: job.name, site: job.site ?? null, sponsor: job.sponsor ?? null, badge: job.badge ?? null, reuse: job.reuse ?? false, write: job.write ?? null };
        active.set(id, state);
        const log = (message) => console.log(`[${short(id)}] ${redact(String(message).trim())}`);
        finish(state, dir, job.report ?? { status: 'ready', files: job.files, ...enclaveConcept(state, dir) }, log)
          // A retry that arrived meanwhile gets a fresh render.
          .then((result) => (result === 'rerender' ? renderCard(state, dir) : undefined))
          .catch((error) => console.error(`[${short(id)}] ${redact(describe(error))}`))
          .finally(() => {
            active.delete(id);
            if (dropped.delete(id)) removeCard(id);
          });
        continue;
      }
      if (job.state !== 'active') continue;
      console.log(`[${short(id)}] resuming after a restart`);
      const hasConcept = existsSync(join(dir, 'concept.json'));
      start({ ...job, concept: hasConcept && !job.write ? readConcept(dir) : undefined });
    } catch (error) {
      console.error(`[${short(id)}] could not resume: ${redact(describe(error))}`);
    }
  }
}

// Deletes card folders that finished more than RETENTION_DAYS ago.
function sweepCards() {
  if (!existsSync(CARDS)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const id of readdirSync(CARDS)) {
    try {
      const path = join(CARDS, id, 'job.json');
      const job = existsSync(path) ? readJson(path) : null;
      if (job && ['done', 'failed', 'cancelled', 'refused'].includes(job.state) && statSync(path).mtimeMs < cutoff) removeCard(id);
    } catch (error) {
      console.error(`[${short(id)}] could not sweep: ${redact(describe(error))}`);
    }
  }
}

function saveJob(dir, job) {
  writeJson(join(dir, 'job.json'), job, { mode: 0o600 });
}

function trySaveJob(dir, job, log) {
  try {
    saveJob(dir, job);
  } catch (error) {
    log(`could not save the job record: ${describe(error)}`);
  }
}

// Runs at most `max` tasks at once; a finishing task hands its slot straight
// to the next waiter so a newcomer cannot slip in between.
function limiter(max) {
  let running = 0;
  const waiting = [];
  return async (task) => {
    if (running < max) running++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

function authorized(header) {
  const given = createHash('sha256').update(String(header ?? '')).digest();
  return timingSafeEqual(given, createHash('sha256').update(`Bearer ${SECRET}`).digest());
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'The body must be JSON.');
  }
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(value === null ? undefined : JSON.stringify(value));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function badRequest(message) {
  throw httpError(400, message);
}

function whole(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
