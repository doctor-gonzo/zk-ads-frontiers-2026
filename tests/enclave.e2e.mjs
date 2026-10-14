// The render service's job lifecycle against a scripted stand-in for the
// worker: uploads and reports, token handover on admin retry, an unreachable
// worker, cancellation, and restarts. Fixture mode, so nothing is paid for.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../lib/share.mjs';
import { sampleConcept } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = !(findChrome() && commandWorks('ffmpeg', ['-version'])) && 'needs Chrome and ffmpeg';
const SECRET = 's'.repeat(40);
const CARD = 'abcdefghijklmnopqrst';
const T1 = 'A'.repeat(43);
const T2 = 'B'.repeat(43);
const tmp = mkdtempSync(join(tmpdir(), 'zkads-enclave-'));
const fixture = join(tmp, 'fixture');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fixture whose orbit is not a video, so every page render fails.
const broken = join(tmp, 'broken');

before(() => {
  if (skip) return;
  mkdirSync(fixture);
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x334455:s=288x512', '-frames:v', '1', join(fixture, 'hero.png'));
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x554433:s=288x512:d=2:r=24', '-pix_fmt', 'yuv420p', join(fixture, 'orbit.mp4'));
  writeFileSync(join(fixture, 'run.json'), JSON.stringify({ video: { status: 'done', duration: '2' } }));
  mkdirSync(broken);
  execFileSync('cp', [join(fixture, 'hero.png'), join(fixture, 'run.json'), broken]);
  writeFileSync(join(broken, 'orbit.mp4'), 'not a video');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

// One enclave plus one stand-in worker; `answer(call)` scripts the worker's replies.
async function harness(answer = () => 200, { media = fixture } = {}) {
  const calls = [];
  const worker = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = req.headers['content-type']?.startsWith('application/json') ? JSON.parse(Buffer.concat(chunks).toString() || 'null') : null;
    const call = { method: req.method, path: req.url.replace(`/internal/cards/${CARD}/`, ''), token: (req.headers.authorization ?? '').slice(7), body, at: Date.now() };
    if (call.path === 'files/index.html') call.page = Buffer.concat(chunks).toString();
    call.status = await answer(call);
    calls.push(call);
    // 'drop' stands in for an answer lost on its way back: the call arrived, the reply never does.
    if (call.status === 'drop') return req.socket.destroy();
    res.writeHead(call.status, { 'content-type': 'application/json' });
    res.end(call.status < 300 ? '{"ok":true}' : '{"error":{"code":"x","message":"x"}}');
  });
  const workerPort = await freePort();
  await new Promise((done) => worker.listen(workerPort, '127.0.0.1', done));
  const data = mkdtempSync(join(tmp, 'data-'));
  const enclavePort = await freePort();
  let child;
  let output = '';
  const start = () => {
    output = '';
    child = spawn(process.execPath, [join(ROOT, 'enclave/server.mjs')], {
      env: { ...process.env, PORT: String(enclavePort), ENCLAVE_SECRET: SECRET, WORKER_URL: `http://127.0.0.1:${workerPort}`, DATA_DIR: data, ENCLAVE_FIXTURE: media, VENICE_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    return until(async () => (await fetch(`http://127.0.0.1:${enclavePort}/health`)).ok, 15_000, 'the enclave to start');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((done) => child.once('exit', done));
    child.kill('SIGKILL');
    await exited;
  };
  const dispatch = (token, extra = {}) =>
    fetch(`http://127.0.0.1:${enclavePort}/jobs/render`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ card_id: CARD, token, name: 'Ada', concept: sampleConcept(), ...extra }) });
  const job = () => JSON.parse(readFileSync(join(data, 'cards', CARD, 'job.json'), 'utf8'));
  const close = async () => {
    await stop();
    await new Promise((done) => worker.close(done));
  };
  return { calls, data, start, stop, dispatch, job, close, alive: () => child.exitCode === null, output: () => output };
}

test('a finished card uploads its media before its page, reports ready once and keeps only what a retry needs', { skip, timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    await h.start();
    assert.equal((await h.dispatch(T1)).status, 202);
    await until(() => h.job().state === 'done', 40_000, 'the card to finish');
    const uploads = h.calls.filter((c) => c.method === 'PUT').map((c) => c.path.replace('files/', ''));
    assert.equal(uploads.at(-1), 'index.html', 'the page goes last');
    assert.ok(uploads.includes('story.mp4') && uploads.includes('poster.jpg'));
    const ready = h.calls.filter((c) => c.body?.status === 'ready');
    assert.equal(ready.length, 1);
    assert.ok(h.calls.every((c) => c.token === T1));
    const kept = join(h.data, 'cards', CARD);
    assert.ok(existsSync(join(kept, 'hero.png')) && existsSync(join(kept, 'orbit.mp4')));
    assert.ok(!existsSync(join(kept, 'story.mp4')) && !existsSync(join(kept, 'layers')), 'uploaded files are pruned');
  } finally {
    await h.close();
  }
});

test('an admin retry during the uploads hands the job a new token, and everything goes out under it', { skip, timeout: 60_000 }, async () => {
  let current = T1;
  let retried = false;
  // The worker retires T1 as soon as the first upload arrives (an admin retry), then accepts only T2.
  const h = await harness(async (call) => {
    if (call.method === 'PUT' && !retried) {
      retried = true;
      current = T2;
      setTimeout(() => h.dispatch(T2), 300);
    }
    return call.token === current ? 200 : 403;
  });
  try {
    await h.start();
    await h.dispatch(T1);
    await until(() => h.job().state === 'done', 40_000, 'the card to finish under the new token');
    const ready = h.calls.filter((c) => c.body?.status === 'ready' && c.status === 200);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].token, T2);
    assert.ok(!h.calls.some((c) => c.body?.status === 'failed'), 'the retry is not reported as a failure');
  } finally {
    await h.close();
  }
});

test('a ready report whose answer was lost is not resent for a newer job that wants a different page', { skip, timeout: 90_000 }, async () => {
  let current = T1;
  let dropped = false;
  // The worker takes the ready report but its answer is lost; meanwhile the person adds a badge (a new job).
  const h = await harness(async (call) => {
    if (call.body?.status === 'ready' && !dropped) {
      dropped = true;
      current = T2;
      h.dispatch(T2, { reuse: true, badge: { value: '1K', label: 'x', source: 'logs' }, usage: { tokens: 1000, period_days: 30 } });
      return 'drop';
    }
    return call.token === current ? 200 : 403;
  });
  try {
    await h.start();
    await h.dispatch(T1);
    await until(() => h.job().state === 'done', 60_000, 'the newer job to finish');
    const accepted = h.calls.filter((c) => c.body?.status === 'ready' && c.status === 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].token, T2);
    assert.deepEqual(accepted[0].body.badge, { value: '1K', label: 'AI tokens in 30 days', source: 'logs' }, 'the old page is never reported under the new token');
  } finally {
    await h.close();
  }
});

test('a worker that is briefly unreachable at the end still gets the ready report', { skip, timeout: 90_000 }, async () => {
  let downUntil = 0;
  const h = await harness(async (call) => {
    if (call.method === 'PUT' && !downUntil) downUntil = Date.now() + 6000;
    return Date.now() < downUntil ? 503 : 200;
  });
  try {
    await h.start();
    await h.dispatch(T1);
    await until(() => h.job().state === 'done', 70_000, 'the ready report to get through');
    assert.ok(h.calls.some((c) => c.status === 503), 'the worker really was down');
    assert.ok(h.calls.some((c) => c.body?.status === 'ready' && c.status === 200));
  } finally {
    await h.close();
  }
});

test('a refused progress report cancels the job before anything is uploaded', { skip, timeout: 60_000 }, async () => {
  const h = await harness((call) => (call.body?.status === 'rendering' ? 403 : 200));
  try {
    await h.start();
    await h.dispatch(T1);
    await until(() => h.job().state === 'cancelled', 30_000, 'the job to stop');
    assert.ok(!h.calls.some((c) => c.method === 'PUT'));
    assert.ok(!h.calls.some((c) => c.body?.status === 'failed'));
  } finally {
    await h.close();
  }
});

test('a failure report never goes out under a newer token: an admin retry gets a fresh attempt instead', { skip, timeout: 90_000 }, async () => {
  let current = T1;
  let retried = false;
  // The failure report under T1 meets a busy worker; meanwhile an admin retry hands the job T2.
  const h = await harness(
    async (call) => {
      if (call.body?.status === 'failed' && call.token === T1 && !retried) {
        retried = true;
        current = T2;
        setTimeout(() => h.dispatch(T2), 200);
        return 503;
      }
      return call.token === current ? 200 : 403;
    },
    { media: broken },
  );
  try {
    await h.start();
    await h.dispatch(T1);
    await until(() => h.calls.some((c) => c.token === T2), 30_000, 'the retry to report');
    const firstUnderT2 = h.calls.find((c) => c.token === T2);
    assert.notEqual(firstUnderT2.body?.status, 'failed', 'the old failure is not sent under the retry’s token');
    assert.equal(firstUnderT2.body?.status, 'rendering', 'the retry gets its own attempt');
  } finally {
    await h.close();
  }
});

test('after a restart, a run that newer content overtook is rendered again, never delivered as it was', { skip, timeout: 120_000 }, async () => {
  const label = 'AI tokens in 30 days';
  let current = T1;
  let joined = false;
  let killed = false;
  const h = await harness(async (call) => {
    // The person adds a badge while the first page is rendering (a new job).
    if (call.body?.step === 'page' && call.token === T1 && !joined) {
      joined = true;
      setTimeout(() => {
        current = T2;
        h.dispatch(T2, { reuse: true, badge: { value: '1K', label: 'x', source: 'logs' }, usage: { tokens: 1000, period_days: 30 } });
      }, 1500);
    }
    // The service dies as the second run starts its page.
    if (call.body?.step === 'page' && call.token === T2 && !killed) {
      killed = true;
      await h.stop();
    }
    return call.token === current ? 200 : 403;
  });
  try {
    await h.start();
    await h.dispatch(T1);
    await until(() => killed, 60_000, 'the second run to start');
    await h.start();
    await until(() => h.job().state === 'done', 60_000, 'the card to finish after the restart');
    const pages = h.calls.filter((c) => c.page && c.token === T2 && c.status === 200);
    assert.ok(pages.length > 0 && pages.every((c) => c.page.includes(label)), 'only pages with the badge go out under the new token');
    assert.ok(h.calls.filter((c) => c.body?.status === 'ready' && c.status === 200).every((c) => c.body.badge?.label === label));
  } finally {
    await h.close();
  }
});

test('after a restart, broken records are skipped and a finished render is still delivered', { skip, timeout: 90_000 }, async () => {
  let accept = false;
  const h = await harness(() => (accept ? 200 : 503));
  try {
    await h.start();
    await h.dispatch(T1);
    // Rendering finishes but the worker stays down, so the job waits to publish.
    await until(() => h.job().state === 'publishing', 40_000, 'the render to finish');
    await h.stop();
    const broken = join(h.data, 'cards', 'zzzzzzzzzzzzzzzzzzzz');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'job.json'), '');
    accept = true;
    await h.start();
    await until(() => h.job().state === 'done', 40_000, 'the saved report to be delivered after the restart');
    assert.ok(h.alive(), 'the broken record did not crash the service');
    assert.match(h.output(), /could not resume/);
  } finally {
    await h.close();
  }
});

async function until(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Not there yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(200);
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = netServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function commandWorks(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
