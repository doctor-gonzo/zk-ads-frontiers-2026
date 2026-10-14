import assert from 'node:assert/strict';
import test from 'node:test';
import { createVenice, describe, isDefiniteFailure, isTransient, VeniceError } from '../lib/venice.mjs';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const file = (bytes, type = 'video/mp4') => new Response(new Uint8Array(bytes), { headers: { 'content-type': type } });
const noSleep = async () => {};

function mockFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request to ${url}`);
    return typeof next === 'function' ? next() : next;
  };
  return { calls, fetchImpl };
}

test('chat requests ask for structured JSON without Venice extras', async () => {
  const { calls, fetchImpl } = mockFetch(json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5 } }));
  const venice = createVenice({ apiKey: 'test-key', fetchImpl });
  const result = await venice.chat({ model: 'kimi-k3', system: 'sys', user: 'hi', schema: { type: 'object' }, reasoningEffort: 'high' });
  assert.deepEqual(result, { content: '{"ok":true}', usage: { prompt_tokens: 5 } });
  const [call] = calls;
  assert.equal(call.url, 'https://api.venice.ai/api/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);
  assert.deepEqual(call.body.response_format, { type: 'json_schema', json_schema: { name: 'zkads_concept', strict: true, schema: { type: 'object' } } });
  assert.equal(call.body.reasoning_effort, 'high');
  assert.equal(call.body.venice_parameters.include_venice_system_prompt, false);
  assert.equal(call.body.venice_parameters.enable_web_search, 'off');
});

test('empty and truncated chat replies are errors, not concepts', async () => {
  const { fetchImpl } = mockFetch(
    json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    json({ choices: [{ message: { content: '{"product_na' }, finish_reason: 'length' }], usage: { completion_tokens: 32000 } }),
  );
  const venice = createVenice({ apiKey: 'k', fetchImpl });
  await assert.rejects(venice.chat({ model: 'm', system: 's', user: 'u' }), /no content \(finish_reason: length\)/);
  await assert.rejects(venice.chat({ model: 'm', system: 's', user: 'u' }), /32000-token limit/);
});

test('paid calls fail fast without a key; quotes are public', async () => {
  const { calls, fetchImpl } = mockFetch(json({ quote: 0.46 }), json({ quote: 0.05 }));
  const venice = createVenice({ fetchImpl });
  await assert.rejects(venice.generateImage({ model: 'm', prompt: 'p' }), /VENICE_API_KEY is not set/);
  assert.equal(await venice.quote('video', { model: 'm', duration: '8s', resolution: '768P' }), 0.46);
  assert.equal(await venice.quote('audio', { model: 'a', duration_seconds: 16 }), 0.05);
  assert.deepEqual(calls.map((c) => [c.url.split('/v1')[1], c.headers.Authorization]), [
    ['/video/quote', undefined],
    ['/audio/quote', undefined],
  ]);
});

test('API errors carry the status, message, details and any suggested prompt', async () => {
  const { fetchImpl } = mockFetch(
    json({ error: 'Content policy', suggested_prompt: 'a calmer prompt' }, 422),
    json({ error: 'Invalid request parameters', details: { duration: ['must be 5s-15s'] } }, 400),
  );
  const venice = createVenice({ apiKey: 'k', fetchImpl });
  await assert.rejects(venice.queue('video', { model: 'm' }), (error) => {
    assert.equal(error.status, 422);
    assert.match(error.message, /\/video\/queue failed \(422\): Content policy Suggested prompt: a calmer prompt/);
    return true;
  });
  await assert.rejects(venice.queue('audio', { model: 'm' }), /\/audio\/queue failed \(400\): Invalid request parameters \{"duration":\["must be 5s-15s"\]\}/);
});

test('images decode from base64 and blurred results are rejected', async () => {
  const { fetchImpl } = mockFetch(json({ images: [Buffer.from('png!').toString('base64')] }), json({ images: ['AA=='] }, 200, { 'x-venice-is-blurred': 'true' }));
  const venice = createVenice({ apiKey: 'k', fetchImpl });
  assert.equal((await venice.generateImage({ model: 'm', prompt: 'p' })).toString(), 'png!');
  await assert.rejects(venice.generateImage({ model: 'm', prompt: 'p' }), /blurred/);
});

test('polling reports progress and returns the file with its type', async () => {
  const { calls, fetchImpl } = mockFetch(json({ status: 'PROCESSING', execution_duration: 1000, average_execution_time: 90000 }), file([1, 2, 3], 'audio/mpeg'));
  const progress = [];
  const venice = createVenice({ apiKey: 'k', fetchImpl, sleep: noSleep });
  const result = await venice.waitFor('audio', { model: 'm', queueId: 'q1', onProgress: (s) => progress.push(s.status) });
  assert.deepEqual([...result.data], [1, 2, 3]);
  assert.equal(result.type, 'audio/mpeg');
  assert.deepEqual(progress, ['PROCESSING']);
  assert.equal(calls[0].url, 'https://api.venice.ai/api/v1/audio/retrieve');
  assert.deepEqual(calls[0].body, { model: 'm', queue_id: 'q1' });
});

test('a finished file served as a generic binary type is still saved', async () => {
  const { fetchImpl } = mockFetch(file([4, 2], 'application/octet-stream'));
  const venice = createVenice({ apiKey: 'k', fetchImpl, sleep: noSleep });
  assert.deepEqual([...(await venice.waitFor('video', { model: 'm', queueId: 'q' })).data], [4, 2]);
});

test('files with a download URL are fetched from it once complete, retrying a flaky CDN', async () => {
  const { calls, fetchImpl } = mockFetch(json({ status: 'COMPLETED' }), new Response('bad gateway', { status: 502 }), json({ status: 'COMPLETED' }), file([9]));
  const venice = createVenice({ apiKey: 'k', fetchImpl, sleep: noSleep });
  const result = await venice.waitFor('video', { model: 'm', queueId: 'q', downloadUrl: 'https://cdn.example/v.mp4' });
  assert.deepEqual([...result.data], [9]);
  assert.equal(calls[1].url, 'https://cdn.example/v.mp4');
  assert.equal(calls[1].headers, undefined, 'the key never goes to the download URL');
});

test('a paid job survives capacity errors and network blips while polling', async () => {
  const { calls, fetchImpl } = mockFetch(
    json({ error: 'The model is at capacity' }, 503),
    () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })),
    json({ status: 'PROCESSING' }),
    file([7]),
  );
  const retries = [];
  const venice = createVenice({ apiKey: 'k', fetchImpl, sleep: noSleep });
  const result = await venice.waitFor('video', { model: 'm', queueId: 'q', onRetry: (e) => retries.push(describe(e)) });
  assert.deepEqual([...result.data], [7]);
  assert.equal(calls.length, 4);
  assert.deepEqual(retries, ['Venice /video/retrieve failed (503): The model is at capacity', 'fetch failed (ECONNRESET)']);
});

test('definite answers stop polling at once', async () => {
  for (const status of [404, 500, 401]) {
    const { calls, fetchImpl } = mockFetch(json({ error: 'no' }, status));
    const venice = createVenice({ apiKey: 'k', fetchImpl, sleep: noSleep });
    await assert.rejects(venice.waitFor('video', { model: 'm', queueId: 'q' }), (error) => error.status === status && !error.resumable);
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test('timeouts are resumable and name the last error', async () => {
  const { fetchImpl } = mockFetch(() => json({ error: 'busy' }, 503), () => json({ error: 'busy' }, 503));
  let now = 0;
  const venice = createVenice({ apiKey: 'k', fetchImpl, sleep: async (ms) => { now += ms; } });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(venice.waitFor('video', { model: 'm', queueId: 'q', pollMs: 6, timeoutMs: 10 }), (error) => {
      assert.equal(error.resumable, true);
      assert.match(error.message, /Timed out waiting for video q\. Last error: Venice \/video\/retrieve failed \(503\): busy\./);
      return true;
    });
  } finally {
    Date.now = realNow;
  }
});

test('retry and failure classes', () => {
  for (const status of [429, 502, 503, 504]) assert.equal(isTransient(new VeniceError('x', status)), true, `${status} retries`);
  for (const status of [400, 401, 402, 403, 404, 422, 500]) assert.equal(isTransient(new VeniceError('x', status)), false, `${status} does not retry`);
  assert.equal(isTransient(new TypeError('fetch failed')), true);
  assert.equal(isTransient(new SyntaxError('bad json')), false);
  for (const status of [400, 404, 422, 500]) assert.equal(isDefiniteFailure(new VeniceError('x', status)), true, `${status} fails the job`);
  for (const status of [401, 402, 403, 429, 503]) assert.equal(isDefiniteFailure(new VeniceError('x', status)), false, `${status} keeps the job`);
  assert.equal(isDefiniteFailure(new VeniceError('VENICE_API_KEY is not set')), false);
  assert.equal(isDefiniteFailure(new TypeError('fetch failed')), false);
});

test('model metadata is fetched once per type', async () => {
  const { calls, fetchImpl } = mockFetch(json({ data: [{ id: 'a' }, { id: 'b' }] }));
  const venice = createVenice({ fetchImpl });
  assert.equal((await venice.model('music', 'b')).id, 'b');
  await assert.rejects(venice.model('music', 'zzz'), /Unknown Venice music model "zzz"/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.venice.ai/api/v1/models?type=music');
});
