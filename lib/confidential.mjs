// Phala Confidential AI: OpenAI-compatible chat completions served from GPU
// TEEs. Each answer carries a receipt id that anyone can check at
// GET /v1/aci/receipts/<id> (see docs.phala.com, Confidential AI).
export const CONFIDENTIAL_AI_URL = 'https://inference.phala.com/v1';
export const CONFIDENTIAL_MODEL = 'moonshotai/kimi-k3';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What an operator can do about a refusal, by status.
const STATUS_HINTS = { 401: ': check CONFIDENTIAL_AI_KEY', 403: ': check CONFIDENTIAL_AI_KEY', 404: ': check the model name', 400: ': the request was refused' };

export function createConfidentialAI({ apiKey, baseUrl = CONFIDENTIAL_AI_URL, fetchImpl = fetch, sleep = wait } = {}) {
  // Busy or briefly unreachable is worth three tries; anything else is final.
  async function post(body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240_000),
        });
      } catch (error) {
        if (attempt >= 3) throw new Error(`Could not reach Confidential AI (${error.cause?.code ?? error.message}).`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.ok) return res;
      // The answer's text is left out: an error could echo the prompt (a
      // summary), and these errors end up in logs that leave the enclave.
      await res.body?.cancel().catch(() => {});
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`Confidential AI answered ${res.status}${STATUS_HINTS[res.status] ?? ''}.`);
    }
  }

  return {
    async chat({ model = CONFIDENTIAL_MODEL, system, user, schema, maxTokens = 16_000 }) {
      if (!apiKey) throw new Error('CONFIDENTIAL_AI_KEY is not set, so the enclave cannot read summaries.');
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
      };
      if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'zkads', strict: true, schema } };
      const res = await post(body);
      // A parse error would quote the start of the answer (which could echo a summary) into logs.
      const data = await res.json().catch(() => Promise.reject(new Error('Confidential AI sent an answer that is not JSON.')));
      return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage ?? null, receipt: res.headers.get('x-receipt-id'), model: data.model ?? model };
    },
  };
}
