// Minimal Venice AI client (https://docs.venice.ai) built on Node's fetch.
// Model listing and video quotes are public; everything else needs a key.

export const VENICE_API = 'https://api.venice.ai/api/v1';

// `kind` overrides the status-based judgement for errors that don't come from
// the Venice API itself, such as a storage server behind a download link.
export class VeniceError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = 'VeniceError';
    this.status = status;
    this.kind = kind;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createVenice({ apiKey, baseUrl = VENICE_API, fetchImpl = fetch, sleep = wait } = {}) {
  const modelLists = new Map();

  async function request(path, { body, auth = true } = {}) {
    if (auth && !apiKey) {
      throw new VeniceError('VENICE_API_KEY is not set. Copy .env.example to .env and add your key.');
    }
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await responseError(res, path);
    return res;
  }

  async function model(type, id) {
    if (!modelLists.has(type)) {
      const res = await request(`/models?type=${type}`, { auth: false });
      modelLists.set(type, (await res.json()).data ?? []);
    }
    const found = modelLists.get(type).find((m) => m.id === id);
    if (!found) throw new VeniceError(`Unknown Venice ${type} model "${id}" (see ${baseUrl}/models?type=${type})`);
    return found;
  }

  async function chat({ model: id, system, user, schema, reasoningEffort, maxTokens = 32000 }) {
    const body = {
      model: id,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_completion_tokens: maxTokens,
      venice_parameters: {
        include_venice_system_prompt: false,
        strip_thinking_response: true,
        enable_web_search: 'off',
      },
    };
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'zkads_concept', strict: true, schema } };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    const data = await (await request('/chat/completions', { body })).json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new VeniceError(`The model returned no content (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
    if (choice.finish_reason === 'length') {
      throw new VeniceError(`The reply hit the ${maxTokens}-token limit before finishing (usage: ${JSON.stringify(data.usage ?? {})}). Try again or lower the reasoning effort.`);
    }
    return { content, usage: data.usage ?? null };
  }

  async function generateImage(body) {
    const res = await request('/image/generate', { body: { ...body, return_binary: false } });
    if (res.headers.get('x-venice-is-content-violation') === 'true') {
      throw new VeniceError('Venice flagged the generated image as a content violation; adjust image_prompt and retry.');
    }
    if (res.headers.get('x-venice-is-blurred') === 'true') {
      throw new VeniceError('Venice blurred the generated image; adjust image_prompt and retry.');
    }
    const image = (await res.json()).images?.[0];
    if (!image) throw new VeniceError('Venice returned no image.');
    return Buffer.from(image, 'base64');
  }

  // Video and audio jobs share one shape: quote, queue, poll /retrieve, complete.
  // `kind` is 'video' or 'audio'; quotes are public, the rest needs the key.
  async function quote(kind, body) {
    const data = await (await request(`/${kind}/quote`, { body, auth: false })).json();
    return data.quote;
  }

  async function queue(kind, body) {
    const data = await (await request(`/${kind}/queue`, { body })).json();
    if (!data.queue_id) throw new VeniceError(`Venice did not return a queue_id for the ${kind}.`);
    return data;
  }

  // Polls until the file is ready. Most models return it from /retrieve; some
  // video models return a download_url at queue time and only report status.
  // The job is already paid for, so capacity errors, rate limits and network
  // blips are retried until the deadline instead of abandoning it.
  async function waitFor(kind, { model: id, queueId, downloadUrl, onProgress, onRetry, pollMs = 8000, timeoutMs = 20 * 60_000 }) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const res = await request(`/${kind}/retrieve`, { body: { model: id, queue_id: queueId } });
        // Anything that isn't a JSON status is the finished file.
        const type = res.headers.get('content-type') ?? '';
        if (!type.includes('application/json')) return { data: Buffer.from(await res.arrayBuffer()), type };
        const status = await res.json();
        if (status.status === 'COMPLETED' && downloadUrl) {
          const file = await fetchImpl(downloadUrl);
          if (file.status === 429 || file.status >= 500) throw new VeniceError(`Download failed (${file.status}).`, file.status, 'transient');
          if (!file.ok) {
            // Download links expire after 24 hours; past that the file cannot be collected.
            throw new VeniceError(`The download link failed (${file.status}); it has probably expired, so this file can no longer be collected.`, file.status, 'definite');
          }
          return { data: Buffer.from(await file.arrayBuffer()), type: file.headers.get('content-type') ?? '' };
        }
        onProgress?.(status);
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastError = error;
        onRetry?.(error);
      }
      await sleep(pollMs);
    }
    const last = lastError ? ` Last error: ${describe(lastError)}.` : '';
    const timeout = new VeniceError(`Timed out waiting for ${kind} ${queueId}.${last}`);
    timeout.resumable = true;
    throw timeout;
  }

  // Asks Venice to delete its copy once the file is saved locally.
  async function complete(kind, { model: id, queueId }) {
    await request(`/${kind}/complete`, { body: { model: id, queue_id: queueId } });
  }

  return { model, chat, generateImage, quote, queue, waitFor, complete };
}

async function responseError(res, path) {
  let detail = '';
  try {
    const data = await res.json();
    const error = data.error;
    const details = data.details ? ` ${JSON.stringify(data.details).slice(0, 400)}` : '';
    detail = typeof error === 'string' ? `${error}${details}` : error?.message ?? JSON.stringify(data).slice(0, 400);
    if (data.suggested_prompt) detail += ` Suggested prompt: ${data.suggested_prompt}`;
  } catch {
    detail = res.statusText;
  }
  return new VeniceError(`Venice ${path} failed (${res.status}): ${detail}`, res.status);
}

// Worth retrying while a paid job finishes: rate limits, gateway/capacity
// errors and network failures (fetch rejects with a TypeError). A 500 from
// retrieve means "inference processing failed", so it is not retried.
export function isTransient(error) {
  if (error instanceof VeniceError) return error.kind ? error.kind === 'transient' : [429, 502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}

// Answers about the job itself: bad request, unknown/expired job, content
// policy, or failed processing. Key and account errors are not in this list.
export function isDefiniteFailure(error) {
  if (!(error instanceof VeniceError)) return false;
  return error.kind ? error.kind === 'definite' : [400, 404, 422, 500].includes(error.status);
}

export function describe(error) {
  const cause = error.cause?.code ?? error.cause?.message;
  return cause ? `${error.message} (${cause})` : error.message;
}
