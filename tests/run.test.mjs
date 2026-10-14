import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRun, runPaidJob, updateRun } from '../lib/run.mjs';
import { VeniceError } from '../lib/venice.mjs';

const spec = { id: 'orbit-model', model_spec: { privacy: 'private' } };

// A Venice stand-in that records calls and answers waitFor from a script.
function fakeVenice({ waitFor = async () => ({ data: Buffer.from('mp4'), type: 'video/mp4' }), complete = async () => {} } = {}) {
  const calls = [];
  return {
    calls,
    quote: async (kind, body) => (calls.push(['quote', kind, body]), 0.46),
    queue: async (kind, body) => (calls.push(['queue', kind, body.model]), { queue_id: 'new-1' }),
    waitFor: async (kind, options) => (calls.push(['waitFor', kind, options.model, options.queueId]), waitFor()),
    complete: async (kind, options) => (calls.push(['complete', kind, options.model, options.queueId]), complete()),
  };
}

function withRun(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zkads-run-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const job = (venice, dir, extra = {}) =>
  runPaidJob({
    venice,
    dir,
    key: 'video',
    kind: 'video',
    spec,
    build: () => ({ body: { model: spec.id }, quote: { model: spec.id, duration: '8s' }, summary: '8s', record: { hero_sha256: 'h1' } }),
    save: ({ data }) => {
      writeFileSync(join(dir, 'orbit.mp4'), data);
      return 'orbit.mp4';
    },
    resumeCommand: 'node zkads.mjs orbit out/run',
    announce: () => {},
    note: () => {},
    ...extra,
  });

test('a new job is quoted, queued, collected, deleted from Venice and recorded', () =>
  withRun(async (dir) => {
    const venice = fakeVenice();
    const { file } = await job(venice, dir);
    assert.equal(file, 'orbit.mp4');
    assert.deepEqual(venice.calls.map((c) => c[0]), ['quote', 'queue', 'waitFor', 'complete']);
    assert.deepEqual(readRun(dir).video, { model: 'orbit-model', privacy: 'private', status: 'done', queue_id: 'new-1', download_url: null, usd: 0.46, hero_sha256: 'h1', file: 'orbit.mp4' });
  }));

test('a paid but uncollected job is resumed, never bought again, even for another model', () =>
  withRun(async (dir) => {
    updateRun(dir, { video: { model: 'older-model', status: 'queued', queue_id: 'paid-1', usd: 0.46 } });
    const venice = fakeVenice();
    const notes = [];
    await job(venice, dir, { announce: (m) => notes.push(m) });
    assert.deepEqual(venice.calls, [
      ['waitFor', 'video', 'older-model', 'paid-1'],
      ['complete', 'video', 'older-model', 'paid-1'],
    ]);
    assert.match(notes[0], /resuming the paid older-model job paid-1 instead of starting orbit-model/);
    assert.equal(readRun(dir).video.status, 'done');
  }));

test('key, account and network problems keep the paid job resumable', () =>
  withRun(async (dir) => {
    for (const error of [new VeniceError('VENICE_API_KEY is not set.'), new VeniceError('Authentication failed', 401), new VeniceError('Insufficient balance', 402), new VeniceError('IP restricted', 403), new TypeError('fetch failed')]) {
      updateRun(dir, { video: { model: spec.id, status: 'queued', queue_id: 'paid-1' } });
      const venice = fakeVenice({ waitFor: async () => { throw error; } });
      await assert.rejects(job(venice, dir), (thrown) => {
        assert.match(thrown.message, /The job is still paid for; resume it with: node zkads\.mjs orbit out\/run/);
        return true;
      });
      assert.equal(readRun(dir).video.status, 'queued', error.message);
      assert.equal(readRun(dir).video.queue_id, 'paid-1');
    }
  }));

test('a definite failure is recorded so the next run can start fresh', () =>
  withRun(async (dir) => {
    for (const status of [400, 404, 422, 500]) {
      updateRun(dir, { video: { model: spec.id, status: 'queued', queue_id: 'paid-1' } });
      const venice = fakeVenice({ waitFor: async () => { throw new VeniceError('rejected', status); } });
      await assert.rejects(job(venice, dir), /rejected/);
      assert.equal(readRun(dir).video.status, 'failed', String(status));
    }
    const venice = fakeVenice();
    await job(venice, dir);
    assert.deepEqual(venice.calls.map((c) => c[0]), ['quote', 'queue', 'waitFor', 'complete']);
  }));

test('a job is still saved when Venice will not delete its copy', () =>
  withRun(async (dir) => {
    const notes = [];
    const venice = fakeVenice({ complete: async () => { throw new VeniceError('Request ID is invalid.', 400); } });
    await job(venice, dir, { note: (m) => notes.push(m) });
    assert.equal(readRun(dir).video.status, 'done');
    assert.ok(notes.some((n) => /did not confirm deleting its copy/.test(n)), notes.join(' | '));
  }));

test('a job is recorded done before Venice is asked to delete its copy', () =>
  withRun(async (dir) => {
    let statusDuringCleanup;
    const venice = fakeVenice({ complete: async () => { statusDuringCleanup = readRun(dir).video.status; } });
    await job(venice, dir);
    assert.equal(statusDuringCleanup, 'done');
  }));

test('the resume command is shown as soon as a job is paid for', () =>
  withRun(async (dir) => {
    const notes = [];
    await job(fakeVenice(), dir, { note: (m) => notes.push(m) });
    assert.match(notes[0], /Paid and queued\. If this gets interrupted, collect it later with: node zkads\.mjs orbit out\/run/);
  }));

test('an expired download link fails the job; a flaky one is retried', async () => {
  const { createVenice } = await import('../lib/venice.mjs');
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const script = (...responses) => async () => responses.shift();
  await withRun(async (dir) => {
    updateRun(dir, { video: { model: spec.id, status: 'queued', queue_id: 'paid-1', download_url: 'https://cdn.example/v.mp4' } });
    const fetchImpl = script(json({ status: 'COMPLETED' }), new Response('', { status: 403 }));
    const venice = { ...fakeVenice(), waitFor: createVenice({ apiKey: 'k', fetchImpl, sleep: async () => {} }).waitFor };
    await assert.rejects(job(venice, dir), /probably expired/);
    assert.equal(readRun(dir).video.status, 'failed');
  });
  await withRun(async (dir) => {
    updateRun(dir, { video: { model: spec.id, status: 'queued', queue_id: 'paid-1', download_url: 'https://cdn.example/v.mp4' } });
    const fetchImpl = script(json({ status: 'COMPLETED' }), new Response('', { status: 500 }), json({ status: 'COMPLETED' }), new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/mp4' } }));
    const venice = { ...fakeVenice(), waitFor: createVenice({ apiKey: 'k', fetchImpl, sleep: async () => {} }).waitFor };
    await job(venice, dir);
    assert.equal(readRun(dir).video.status, 'done');
  });
});
