// The registry's card rules against an in-memory stand-in for Durable Object
// storage (Cloudflare's module is swapped for a stub), so they run under
// plain Node with any clock: follow-up renders, reverts and refunds, drafts,
// the brand queue and the hourly sweep.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

const stub = `data:text/javascript,${encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) { return specifier === 'cloudflare:workers' ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : next(specifier, context); }`)}`);
const { Registry } = await import('../worker/registry.mjs');

const OWNER = 'user:ada';
const NOW = Date.UTC(2026, 9, 10, 12);
const P1 = { value: '41M', label: 'Codex tokens', source: 'zktls' };
const P2 = { value: '50M', label: 'Codex tokens', source: 'zktls' };

function memoryRegistry() {
  const store = new Map();
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));
  // Like Durable Object storage, at most 128 keys per call.
  const most = (keys) => assert.ok(keys.length <= 128, `${keys.length} keys in one storage call`);
  const storage = {
    async get(key) {
      if (Array.isArray(key)) most(key);
      return Array.isArray(key) ? new Map(key.filter((k) => store.has(k)).map((k) => [k, copy(store.get(k))])) : copy(store.get(key));
    },
    async put(key, value) {
      const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
      most(entries);
      for (const [k, v] of entries) store.set(k, copy(v));
    },
    async delete(key) {
      most([key].flat());
      for (const k of [key].flat()) store.delete(k);
    },
    async list({ prefix = '', limit = Infinity, startAfter = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && k > startAfter).sort().slice(0, limit);
      return new Map(keys.map((k) => [k, copy(store.get(k))]));
    },
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
  };
  return { registry: new Registry({ storage }, { CARDS_PER_DAY: '300' }), store };
}

async function readyCard(registry, extra = {}) {
  const card = { id: 'c'.repeat(20), owner: OWNER, status: 'ready', step: null, files: ['index.html', 'story.mp4'], job: null, last_job: 'j0', concept: { product_name: 'X' }, page_badge: null, created_at: NOW, updated_at: NOW, ...extra };
  await registry.ctx.storage.put(`card:${card.id}`, card);
  return card.id;
}

async function prove(registry, session, badge, job) {
  await registry.saveProof(session, { card_id: 'c'.repeat(20), owner: OWNER, status: 'pending', expires_at: NOW + 60_000 });
  return registry.finishProof(session, { status: 'verified', badge }, job, NOW);
}

test('a proved badge that does not reach the page is retried twice, counting only renders queued, and a new proof starts afresh', async () => {
  const { registry } = memoryRegistry();
  const id = await readyCard(registry);
  assert.equal((await prove(registry, 's1', P1, 'j1')).card.status, 'queued');
  // The re-render could not even be sent (what rerender() reports): the card is
  // as it was, nothing has been counted, and the scheduled sweep will send the
  // follow-up once it is due.
  const failed = await registry.jobStatus(id, 'j1', { status: 'failed', error: 'unreachable', unsent: true }, NOW);
  assert.equal(failed.followUp, true);
  assert.equal((await registry.card(id)).follow_up_tries, 0);
  assert.deepEqual(await registry.dueFollowUps(NOW), []);
  assert.deepEqual(await registry.dueFollowUps(NOW + 120_000), [id]);
  // A follow-up the renderer never received gives its try back, however long the outage.
  for (const job of ['u1', 'u2', 'u3']) {
    assert.ok((await registry.queueFollowUp(id, job, NOW)).ok);
    await registry.jobStatus(id, job, { status: 'failed', error: 'unreachable', unsent: true }, NOW);
  }
  assert.equal((await registry.card(id)).follow_up_tries, 0);
  // Renders that run and fail are what count.
  for (const job of ['j2', 'j3']) {
    assert.ok((await registry.queueFollowUp(id, job, NOW)).ok);
    await registry.jobStatus(id, job, { status: 'failed', error: 'still broken' }, NOW);
  }
  assert.equal((await registry.card(id)).follow_up_tries, 2);
  assert.equal((await registry.queueFollowUp(id, 'j4', NOW)).ok, false, 'two in a row at most');
  assert.deepEqual(await registry.dueFollowUps(NOW + 1e9), [], 'nothing left for the sweep');
  // A later proof lands mid-render (a sponsor's, say) with the budget spent: it still gets its follow-up.
  await registry.ctx.storage.put(`card:${id}`, { ...(await registry.card(id)), status: 'rendering', job: 'j5', rerender: true });
  assert.equal((await prove(registry, 's2', P2, 'unused')).card, null);
  const done = await registry.jobStatus(id, 'j5', { status: 'ready', files: ['index.html'], page_badge: P1 }, NOW);
  assert.equal(done.followUp, true, 'the page shows the older badge');
  assert.ok((await registry.queueFollowUp(id, 'j6', NOW)).ok);
  assert.equal((await registry.jobStatus(id, 'j6', { status: 'ready', files: ['index.html'], page_badge: P2 }, NOW)).followUp, false);
  const card = await registry.card(id);
  assert.deepEqual([card.page_badge, card.follow_up_tries, card.follow_up_after], [P2, 0, null]);
});

test('a badge that reaches the page at last clears the error its failed render left', async () => {
  const { registry } = memoryRegistry();
  const id = await readyCard(registry);
  await prove(registry, 's1', P1, 'j1');
  await registry.jobStatus(id, 'j1', { status: 'failed', error: 'Rendering stopped.' }, NOW);
  assert.equal((await registry.card(id)).last_error, 'Rendering stopped.');
  assert.ok((await registry.queueFollowUp(id, 'j2', NOW)).ok);
  await registry.jobStatus(id, 'j2', { status: 'ready', files: ['index.html'], page_badge: P1 }, NOW);
  assert.equal((await registry.card(id)).last_error, null);
});

test('a change a person starts gets its own follow-ups, even after earlier ones ran out', async () => {
  const { registry } = memoryRegistry();
  // An earlier render left files the record does not have, and both follow-ups were spent.
  const id = await readyCard(registry, { upload_unconfirmed: true, follow_up_tries: 2 });
  assert.equal((await registry.queueFollowUp(id, 'j0', NOW)).ok, false);
  const [brand] = await registry.brands();
  assert.ok((await registry.sponsor(id, OWNER, { brand: brand.name, name: 'N', teaser: 'T', credits: 1, brand_id: brand.id, price: 1 }, 'j1', NOW)).ok);
  assert.equal((await registry.card(id)).follow_up_tries, 0);
  // Its "ready" never arrives: the card reverts, and its page still needs fixing.
  const stale = await registry.markStale(id, 45 * 60_000, 'quiet', NOW + 46 * 60_000);
  assert.equal(stale.followUp, true);
  assert.ok((await registry.queueFollowUp(id, 'j2', NOW)).ok);
  // An admin retry starts afresh too.
  await registry.ctx.storage.put(`card:${id}`, { ...(await registry.card(id)), status: 'ready', job: null, rerender: false, follow_up_tries: 2, last_error: 'old' });
  const retried = await registry.restart(id, 'j3', NOW);
  assert.deepEqual([retried.follow_up_tries, retried.last_error, retried.rerender], [0, null, true]);
});

test('a badge that lands after a failed sponsorship keeps that failure on show', async () => {
  const { registry } = memoryRegistry();
  const id = await readyCard(registry);
  const [brand] = await registry.brands();
  assert.ok((await registry.sponsor(id, OWNER, { brand: brand.name, name: 'N', teaser: 'T', credits: 1, brand_id: brand.id, price: 1 }, 'j1', NOW)).ok);
  await prove(registry, 's1', P1, 'unused');
  // The sponsored render fails: the item is undone, and the proof still needs its own render.
  assert.equal((await registry.jobStatus(id, 'j1', { status: 'failed', error: 'Rendering stopped.' }, NOW)).followUp, true);
  assert.ok((await registry.queueFollowUp(id, 'j2', NOW)).ok);
  await registry.jobStatus(id, 'j2', { status: 'ready', files: ['index.html'], page_badge: P1 }, NOW);
  const card = await registry.card(id);
  assert.deepEqual([card.page_badge, card.sponsor, card.last_error], [P1, null, 'Rendering stopped.']);
  // A new proof is a new change: if its own render fails and a follow-up lands it, its error clears.
  assert.equal((await prove(registry, 's2', P2, 'j3')).card.status, 'queued');
  await registry.jobStatus(id, 'j3', { status: 'failed', error: 'Rendering stopped again.' }, NOW);
  assert.ok((await registry.queueFollowUp(id, 'j4', NOW)).ok);
  await registry.jobStatus(id, 'j4', { status: 'ready', files: ['index.html'], page_badge: P2 }, NOW);
  assert.equal((await registry.card(id)).last_error, null);
});

test('the follow-up list prunes cards no longer waiting and reads past 128 of them', async () => {
  const { registry, store } = memoryRegistry();
  const ids = Array.from({ length: 130 }, (_, n) => `f${String(n).padStart(19, 'a')}`);
  for (const id of ids) store.set(`card:${id}`, { id, status: 'ready', follow_up_after: NOW });
  store.set('card:gone', { id: 'gone', status: 'ready', follow_up_after: null });
  store.set('follow-ups', [...ids, 'gone']);
  assert.equal((await registry.dueFollowUps(NOW)).length, 130);
  assert.ok(!store.get('follow-ups').includes('gone'));
});

test('a failed re-render puts back what it replaced, and the next change clears its error', async () => {
  const { registry } = memoryRegistry();
  const L1 = { value: '1K', label: 'AI tokens in 30 days', source: 'logs' };
  const L2 = { value: '2K', label: 'AI tokens in 30 days', source: 'logs' };
  const id = await readyCard(registry, { badge: L1, page_badge: L1, usage: { tokens: 1000 } });
  assert.ok((await registry.restyle(id, OWNER, { badge: L2, usage: { tokens: 2000 } }, 'j1', NOW)).ok);
  assert.deepEqual(await registry.jobStatus(id, 'j1', { status: 'failed', error: 'Rendering stopped.' }, NOW), { ok: true, followUp: false });
  const card = await registry.card(id);
  assert.deepEqual([card.status, card.badge, card.usage, card.last_error, card.before], ['ready', L1, { tokens: 1000 }, 'Rendering stopped.', null]);
  assert.equal((await registry.restyle(id, 'user:eve', {}, 'j2', NOW)).code, 'not_found', 'only an owner restyles');
  assert.ok((await registry.restyle(id, OWNER, { badge: L2, usage: { tokens: 2000 } }, 'j3', NOW)).ok);
  assert.equal((await registry.card(id)).last_error, null, 'a new change starts with no old error');
});

test('a sponsored re-render that fails refunds both sides once', async () => {
  const { registry } = memoryRegistry();
  const id = await readyCard(registry);
  const [brand] = await registry.brands();
  assert.ok((await registry.sponsor(id, OWNER, { brand: brand.name, name: 'N', teaser: 'T', credits: 3, brand_id: brand.id, price: 5 }, 'j1', NOW)).ok);
  assert.equal(await registry.credits(OWNER), 3);
  await registry.jobStatus(id, 'j1', { status: 'failed', error: 'x' }, NOW);
  assert.equal((await registry.jobStatus(id, 'j1', { status: 'failed', error: 'x' }, NOW)).ok, false, 'a repeated report changes nothing');
  assert.equal(await registry.credits(OWNER), 0);
  assert.equal((await registry.brands()).find((b) => b.id === brand.id).spent, 0);
  assert.equal((await registry.card(id)).sponsor, null);
});

test('files a failed re-render uploaded are rendered away, and a quiet re-render reverts the same way', async () => {
  const { registry } = memoryRegistry();
  const id = await readyCard(registry);
  assert.ok((await registry.restyle(id, OWNER, { badge: null }, 'j1', NOW)).ok);
  assert.equal(await registry.beginUpload(id, 'j0', NOW), false, 'only the current job uploads');
  // Marked before the file is written, so even a write that lands late is covered.
  assert.ok(await registry.beginUpload(id, 'j1', NOW));
  assert.equal((await registry.card(id)).upload_unconfirmed, true);
  // Its new page is live, but the render never confirmed it: the page is behind its record.
  assert.equal((await registry.jobStatus(id, 'j1', { status: 'failed', error: 'x' }, NOW)).followUp, true);
  assert.ok((await registry.queueFollowUp(id, 'j2', NOW)).ok);
  assert.equal((await registry.jobStatus(id, 'j2', { status: 'ready', files: ['index.html'], page_badge: null }, NOW)).followUp, false);
  assert.equal((await registry.card(id)).upload_unconfirmed, false);
  // A re-render that went quiet before uploading anything reverts without a follow-up.
  assert.ok((await registry.restyle(id, OWNER, { badge: null }, 'j3', NOW)).ok);
  const stale = await registry.markStale(id, 45 * 60_000, 'The renderer stopped reporting.', NOW + 46 * 60_000);
  assert.deepEqual([stale.card.status, stale.card.last_error, stale.followUp], ['ready', 'The renderer stopped reporting.', false]);
});

test('drafts: five wait at once for a day each, and a start that never reached the renderer waits again', async () => {
  const { registry } = memoryRegistry();
  const draft = (n, at = NOW) => ({ id: `d${String(n).padStart(19, 'a')}`, owner: OWNER, status: 'waiting_summary', files: [], job: null, write: { kind: 'summary' }, created_at: at, updated_at: at });
  for (let n = 0; n < 5; n++) assert.ok((await registry.createDraft(draft(n), 5, NOW)).ok);
  assert.equal((await registry.createDraft(draft(5), 5, NOW)).code, 'drafts_waiting');
  assert.ok((await registry.createDraft(draft(5), 5, NOW + 86_400_001)).ok, 'drafts over a day old no longer count');
  const first = draft(0).id;
  assert.ok((await registry.startDraft(first, OWNER, 'j1', NOW + 1000)).ok);
  assert.equal((await registry.capStatus(NOW)).used_today, 1);
  await registry.refund(first, 'unreachable', NOW + 2000);
  const waiting = await registry.card(first);
  assert.deepEqual([waiting.status, waiting.created_at, waiting.job], ['waiting_summary', NOW, null]);
  assert.equal((await registry.capStatus(NOW)).used_today, 0, 'the slot is returned');
  assert.ok((await registry.startDraft(first, OWNER, 'j2', NOW + 3000)).ok, 'it can be started again');
  // Started in its last moments, its day is over by the time the dispatch fails: it fails as it is.
  await registry.refund(first, 'unreachable', NOW + 86_400_000);
  assert.deepEqual([(await registry.card(first)).status, (await registry.card(first)).error], ['failed', 'unreachable']);
  // A draft waits one day.
  const second = draft(1).id;
  assert.equal((await registry.startDraft(second, OWNER, 'j3', NOW + 86_400_000)).code, 'not_waiting');
  const expired = await registry.markStale(second, 45 * 60_000, 'x', NOW + 86_400_001);
  assert.deepEqual([expired.card.status, expired.card.error], ['failed', 'The summary for this card never arrived.']);
});

test('brands wait for review three per member and thirty in all', async () => {
  const { registry } = memoryRegistry();
  const bid = (n, owner) => registry.addBrand({ id: `bid-${n}`, owner, status: 'pending', name: `B${n}`, budget: 1000, spent: 0 });
  for (let n = 0; n < 3; n++) assert.equal(await bid(n, 'user:a'), true);
  assert.equal(await bid(3, 'user:a'), 'pending');
  for (let n = 3; n < 30; n++) assert.equal(await bid(n, `user:${n}`), true);
  assert.equal(await bid(30, 'user:new'), 'queue');
});

test('the hourly sweep deletes expired invite halves, event codes and claim codes, and keeps admin invites', async () => {
  const { registry, store } = memoryRegistry();
  await registry.createInvites([{ hash: 'admin', label: 'e2e', uses: 5 }], NOW);
  await registry.createInvites([{ hash: 'over', label: 'last year', uses: 5 }], NOW, { event: true, expires_at: Date.now() - 1 });
  await registry.createFusionInvite('fused', { status: 'open', expires_at: Date.now() - 1 }, NOW, true);
  store.set('claim:old', { user_id: 'g0', expires_at: Date.now() - 1 });
  await registry.alarm();
  assert.ok(store.has('invite:admin'));
  assert.ok(!store.has('invite:over') && !store.has('claim:old'));
  assert.ok(!store.has('invite:fused') && !store.has('fusion-invite:fused'));
});

test('an event code starts guest accounts that last as long as it does, and each is saved with a passkey once', async () => {
  const { registry, store } = memoryRegistry();
  const DAY = 86_400_000;
  await registry.createInvites([{ hash: 'event', label: 'frontiers', uses: 2 }], NOW, { event: true, expires_at: NOW + DAY });
  await registry.createInvites([{ hash: 'plain', label: 'friends', uses: 5 }], NOW);
  const guest = (n) => ({ user: { id: `g${n}`, handle: `zkads-g${n}` }, token: { hash: `t${n}`, record: { owner: `user:g${n}`, label: 'Claude', scope: 'agent', created_at: NOW, expires_at: NOW + 30 * DAY } }, claim: `c${n}` });
  assert.equal((await registry.createGuest({ invite: 'plain', ...guest(0) }, NOW)).code, 'not_event_code');
  assert.equal((await registry.createGuest({ invite: 'event', ...guest(0) }, NOW + DAY)).code, 'bad_code', 'expired');
  assert.deepEqual(await registry.createGuest({ invite: 'event', ...guest(1) }, NOW), { ok: true, expires_at: NOW + DAY }, 'a guest ends with its event code');
  assert.ok((await registry.createGuest({ invite: 'event', ...guest(2) }, NOW)).ok);
  assert.equal((await registry.createGuest({ invite: 'event', ...guest(3) }, NOW)).code, 'bad_code', 'used up');
  assert.ok(!store.has('user:g0') && !store.has('user:g3') && !store.has('token:t3'));
  assert.equal((await registry.user('g1')).guest, true);
  assert.deepEqual([(await registry.token('t1', NOW)).owner, (await registry.token('t1', NOW)).event], ['user:g1', 'event']);
  assert.equal(await registry.token('t1', NOW + DAY), null);
  assert.equal(await registry.inviteUsable('plain'), true, 'an ordinary invite is untouched');

  // Saving adds a passkey and a session to the same account, and ends its guest sign-ins.
  assert.equal((await registry.claimable('c1', NOW)).id, 'g1');
  const session = (hash, owner = 'user:g1') => ({ hash, record: { owner, label: 'passkey', scope: 'session', created_at: NOW, expires_at: NOW + DAY } });
  const credential = { id: 'cred1', public_key: 'pk', counter: 0, transports: [], webauthn_user_id: 'w1' };
  assert.ok((await registry.claimGuest({ claim: 'c1', credential, session: session('s1') }, NOW)).ok);
  const saved = await registry.user('g1');
  assert.deepEqual([saved.guest, saved.claim, (await registry.credential('cred1')).user_id], [false, undefined, 'g1']);
  assert.equal((await registry.token('s1', NOW)).owner, 'user:g1');
  assert.equal(await registry.token('t1', NOW), null, 'whoever held the guest sign-in keeps nothing');
  assert.deepEqual((await registry.tokensOf('user:g1', NOW)).map((t) => t.scope), ['session']);
  assert.equal(await registry.claimable('c1', NOW), null);
  assert.equal((await registry.claimGuest({ claim: 'c1', credential: { ...credential, id: 'cred2' }, session: session('s2') }, NOW)).code, 'bad_claim', 'once');
  assert.ok(!store.has('cred:cred2') && !store.has('token:s2'));
  // A claim saves only its own account, and a passkey that already belongs to an account cannot save another.
  assert.equal((await registry.claimGuest({ claim: 'c2', credential: { ...credential, id: 'cred3' }, session: session('s3') }, NOW)).code, 'bad_claim');
  assert.equal((await registry.claimGuest({ claim: 'c2', credential, session: session('s4', 'user:g2') }, NOW)).code, 'duplicate');
  assert.ok(!store.has('cred:cred3') && !store.has('token:s3') && !store.has('token:s4'));
  assert.ok((await registry.token('t2', NOW)) && (await registry.user('g2')).guest);
  assert.ok(await registry.claimable('c2', NOW));

  // Revoking the event code ends its unsaved guests at once; a saved account stays.
  assert.equal((await registry.revokeInvite('event')).revoked, true);
  assert.equal(await registry.token('t2', NOW), null);
  assert.equal(await registry.claimable('c2', NOW), null);
  assert.equal((await registry.token('s1', NOW)).owner, 'user:g1');
  assert.equal((await registry.revokeInvite('event')).revoked, false);
  assert.deepEqual(await registry.revokeInvite('plain'), { revoked: true, forget: [] });
  assert.equal(await registry.inviteUsable('plain'), false);

  // Revoking a guest's sign-ins (revoke {owner}) also takes its way back in, and its cards out of matching.
  await registry.createInvites([{ hash: 'event2', label: 'frontiers', uses: 5 }], NOW, { event: true, expires_at: NOW + DAY });
  assert.ok((await registry.createGuest({ invite: 'event2', ...guest(5) }, NOW)).ok);
  store.set(`card:${'m'.repeat(20)}`, { id: 'm'.repeat(20), owner: 'user:g5', status: 'ready', files: [], matching: { open: true, until: NOW + 3_600_000 } });
  store.set('pool', ['m'.repeat(20)]);
  assert.deepEqual(await registry.revokeAll('user:g5'), { revoked: 1, forget: [`card:${'m'.repeat(20)}`] });
  assert.equal(await registry.token('t5', NOW), null);
  assert.equal(await registry.claimable('c5', NOW), null);
  assert.ok(!store.has('claim:c5'));
  assert.deepEqual([(await registry.card('m'.repeat(20))).matching, store.get('pool')], [{ open: false }, []]);
  assert.deepEqual(await registry.revokeAll(OWNER), { revoked: 0, forget: [] }, 'a member keeps its cards as they are');
  // An unsaved guest lasts as long as its event code.
  assert.ok((await registry.createGuest({ invite: 'event2', ...guest(6) }, NOW)).ok);
  assert.equal(await registry.claimable('c6', NOW + DAY), null);
});

test('a guest’s five cards a day are taken with the cap slot and given back with it', async () => {
  const { registry } = memoryRegistry();
  const card = (n, extra = {}) => ({ id: `g${String(n).padStart(19, 'a')}`, owner: 'user:guest', status: 'queued', files: [], job: 'j', created_at: NOW, updated_at: NOW, ...extra });
  assert.ok((await registry.createCard(card(1), NOW, 2)).ok);
  assert.ok((await registry.createCard(card(2), NOW, 2)).ok);
  assert.equal((await registry.createCard(card(3), NOW, 2)).code, 'guest_limit');
  assert.equal((await registry.capStatus(NOW)).used_today, 2, 'a refused card takes no slot');
  // A card that never reached the renderer gives back both.
  await registry.refund(card(2).id, 'unreachable', NOW);
  assert.equal((await registry.capStatus(NOW)).used_today, 1);
  assert.ok((await registry.createCard(card(3), NOW, 2)).ok);
  // A draft started by a guest counts the same way.
  await registry.ctx.storage.put(`card:${card(4).id}`, card(4, { status: 'waiting_summary', write: { kind: 'summary' } }));
  assert.equal((await registry.startDraft(card(4).id, 'user:guest', 'j4', NOW, 2)).code, 'guest_limit');
  assert.ok((await registry.startDraft(card(4).id, 'user:guest', 'j4', NOW, 3)).ok);
  // Others are untouched, and the cap still comes first.
  assert.ok((await registry.createCard({ ...card(5), owner: OWNER }, NOW)).ok);
  assert.equal((await registry.capStatus(NOW)).used_today, 4);
  await registry.setCap(4, NOW);
  assert.equal((await registry.createCard(card(6), NOW, 9)).code, 'daily_cap');
});

test('a guest’s fusion invite lets a newcomer join only while its event code is open, spending one of its uses', async () => {
  const { registry } = memoryRegistry();
  await registry.createInvites([{ hash: 'event', label: 'frontiers', uses: 2 }], NOW, { event: true, expires_at: Date.now() + 86_400_000 });
  const fusion = (hash) => registry.createFusionInvite(hash, { status: 'open', owner: 'user:guest', expires_at: Date.now() + 86_400_000 }, NOW, true, 'event');
  const join = (invite, n) => registry.register({ invite, user: { id: `u${n}`, handle: `zkads-u${n}` }, credential: { id: `cred${n}`, public_key: 'pk', counter: 0, transports: [], webauthn_user_id: `w${n}` }, session: { hash: `s${n}`, record: { owner: `user:u${n}`, scope: 'session', created_at: NOW, expires_at: Date.now() + 86_400_000 } } }, NOW);
  await fusion('f1');
  await fusion('f2');
  await fusion('f3');
  assert.equal(await registry.inviteUsable('f1'), true);
  assert.ok((await join('f1', 1)).ok);
  assert.equal((await registry.ctx.storage.get('invite:event')).uses_left, 1, 'it spent one of the code’s uses');
  assert.ok((await join('f2', 2)).ok);
  assert.equal(await registry.inviteUsable('f3'), false, 'the code is used up');
  assert.equal((await join('f3', 3)).code, 'bad_invite');
  // Revoked, the code lets nobody in through its guests' invites either.
  await registry.createInvites([{ hash: 'event2', label: 'frontiers', uses: 5 }], NOW, { event: true, expires_at: Date.now() + 86_400_000 });
  await registry.createFusionInvite('f4', { status: 'open', owner: 'user:guest', expires_at: Date.now() + 86_400_000 }, NOW, true, 'event2');
  await registry.revokeInvite('event2');
  assert.equal(await registry.inviteUsable('f4'), false);
  assert.equal((await join('f4', 4)).code, 'bad_invite');
  // A member's invite hangs on nothing.
  await registry.createFusionInvite('f5', { status: 'open', owner: OWNER, expires_at: Date.now() + 86_400_000 }, NOW, true);
  assert.ok((await join('f5', 5)).ok);
});

test('saving a guest account takes its cards out of matching and names their summaries to delete', async () => {
  const { registry, store } = memoryRegistry();
  await registry.createInvites([{ hash: 'event', label: 'frontiers', uses: 5 }], NOW, { event: true, expires_at: NOW + 86_400_000 });
  const owner = 'user:g1';
  assert.ok((await registry.createGuest({ invite: 'event', user: { id: 'g1', handle: 'zkads-g1' }, token: { hash: 't1', record: { owner, label: 'Claude', scope: 'agent', created_at: NOW, expires_at: NOW + 30 * 86_400_000 } }, claim: 'c1' }, NOW)).ok);
  const open = { id: 'o'.repeat(20), owner, status: 'ready', files: [], matching: { open: true, until: NOW + 3_600_000 }, created_at: NOW, updated_at: NOW };
  const draft = { id: 'd'.repeat(20), owner, status: 'waiting_summary', files: [], write: { kind: 'summary' }, created_at: NOW, updated_at: NOW };
  // One more of its cards is open to matching but has fallen off the list of its newest hundred.
  const unlisted = { ...open, id: 'u'.repeat(20) };
  const other = { ...open, id: 'x'.repeat(20), owner: 'user:someone' };
  for (const card of [open, draft, unlisted, other]) store.set(`card:${card.id}`, card);
  store.set(`cards-of:${owner}`, [open.id, draft.id]);
  store.set('pool', [open.id, unlisted.id, other.id]);
  const saved = await registry.claimGuest({ claim: 'c1', credential: { id: 'cred1', public_key: 'pk', counter: 0, transports: [], webauthn_user_id: 'w1' }, session: { hash: 's1', record: { owner, scope: 'session', created_at: NOW + 1000, expires_at: Date.now() + 86_400_000 } } }, NOW + 1000);
  assert.deepEqual(saved, { ok: true, forget: [`card:${open.id}`, `card:${draft.id}`, `draft:${draft.id}`, `card:${unlisted.id}`] });
  assert.deepEqual([(await registry.card(open.id)).matching, (await registry.card(unlisted.id)).matching], [{ open: false }, { open: false }]);
  assert.deepEqual(store.get('pool'), [other.id], 'someone else’s card stays');
  // Drafts from before the save fail (their summaries may be the guest sign-in holder's), so they neither wait nor fill the five places.
  assert.equal((await registry.card(draft.id)).status, 'failed');
  assert.equal((await registry.startDraft(draft.id, owner, 'j1', NOW + 2000)).code, 'not_waiting');
  // One a request already under way wrote just after the save is refused at the start; a new one starts.
  const late = { ...draft, id: 'l'.repeat(20), created_at: NOW + 500 };
  const fresh = { ...draft, id: 'f'.repeat(20), created_at: NOW + 1500 };
  store.set(`card:${late.id}`, late);
  store.set(`card:${fresh.id}`, fresh);
  assert.equal((await registry.startDraft(late.id, owner, 'j2', NOW + 2000)).code, 'stale_draft');
  assert.ok((await registry.startDraft(fresh.id, owner, 'j3', NOW + 2000)).ok);
  // A request that passed the guest's sign-in before the save opens nothing after it.
  assert.equal(await registry.setMatching(open.id, owner, NOW + 3_600_000, 't1'), null);
  assert.deepEqual((await registry.card(open.id)).matching, { open: false });
  assert.ok(await registry.setMatching(open.id, owner, NOW + 3_600_000, 's1'), 'the saved account’s own session can');
  // Its fusion invites from before the save are refused; new ones work.
  store.set('fusion-invite:old', { card_id: open.id, owner, status: 'open', created_at: NOW, expires_at: NOW + 86_400_000 });
  store.set('fusion-invite:new', { card_id: open.id, owner, status: 'open', created_at: NOW + 2000, expires_at: NOW + 86_400_000 });
  const fusion = (id) => ({ id, status: 'waiting_summary', a: { card_id: open.id, owner }, b: { owner: 'user:friend' } });
  assert.equal(await registry.fusionInvite('old', NOW + 3000), null, 'and it does not look open');
  assert.equal((await registry.claimFusionInvite('old', 'user:friend', fusion('fo'), NOW + 3000)).code, 'used');
  assert.ok(await registry.fusionInvite('new', NOW + 3000));
  assert.ok((await registry.claimFusionInvite('new', 'user:friend', fusion('fn'), NOW + 3000)).ok);
  // Writes a request started with the guest's sign-in, landing after the save, change nothing.
  const late2 = { ...draft, id: 'k'.repeat(20), created_at: Date.now() };
  assert.equal((await registry.createDraft(late2, 5, Date.now(), 't1')).code, 'signed_out');
  assert.equal((await registry.createCard({ ...late2, status: 'queued' }, Date.now(), 5, 't1')).code, 'signed_out');
  assert.equal(await registry.createFusionInvite('late', { card_id: open.id, owner, status: 'open', created_at: Date.now(), expires_at: Date.now() + 86_400_000 }, Date.now(), true, 'event', 't1'), false);
  assert.equal((await registry.startDraft(fresh.id, owner, 'j4', Date.now(), 5, 't1')).code, 'signed_out');
  assert.equal((await registry.deleteCard(fresh.id, owner, 't1')).code, 'signed_out', 'nor deletes');
  assert.ok(store.has(`card:${fresh.id}`));
  assert.ok(!store.has(`card:${late2.id}`) && !store.has('fusion-invite:late') && !store.has('invite:late'));
  // A Codex proof started before the save puts no badge on the saved account's card; one started after does.
  await registry.saveProof('p-old', { card_id: open.id, owner, status: 'pending', created_at: NOW, expires_at: Date.now() + 1_800_000 });
  await registry.saveProof('p-new', { card_id: open.id, owner, status: 'pending', created_at: NOW + 2000, expires_at: Date.now() + 1_800_000 });
  const badge = { value: '41M', label: 'Codex tokens', source: 'zktls' };
  assert.deepEqual(await registry.finishProof('p-old', { status: 'verified', badge }, 'jp1', Date.now()), { ok: true, card: null });
  assert.deepEqual([(await registry.proof('p-old', Date.now())).status, (await registry.card(open.id)).badge], ['failed', undefined]);
  assert.ok((await registry.finishProof('p-new', { status: 'verified', badge }, 'jp2', Date.now())).ok);
  assert.deepEqual((await registry.card(open.id)).badge, badge);
});

test('a member takes a guest account’s cards: they move, and whoever held the guest sign-in keeps nothing', async () => {
  const { registry, store } = memoryRegistry();
  await registry.createInvites([{ hash: 'event', label: 'frontiers', uses: 5 }], NOW, { event: true, expires_at: NOW + 86_400_000 });
  const guestOf = (n) => ({ invite: 'event', user: { id: `g${n}`, handle: `zkads-g${n}` }, token: { hash: `t${n}`, record: { owner: `user:g${n}`, label: 'Claude', scope: 'agent', created_at: NOW, expires_at: NOW + 30 * 86_400_000 } }, claim: `c${n}` });
  assert.ok((await registry.createGuest(guestOf(1), NOW)).ok);
  const from = 'user:g1';
  const card = (letter, extra = {}) => ({ id: letter.repeat(20), owner: from, status: 'ready', files: [], created_at: NOW, updated_at: NOW, ...extra });
  const open = card('o', { matching: { open: true, until: NOW + 3_600_000 }, sponsor: { brand: 'b1', credited_to: from } });
  const draft = card('d', { status: 'waiting_summary', write: { kind: 'summary' }, drafted_at: NOW });
  // One more of its cards is open to matching but has fallen off its list.
  const unlisted = card('u', { matching: { open: true, until: NOW + 3_600_000 } });
  const other = card('x', { owner: 'user:someone' });
  const mine = card('m', { owner: OWNER });
  for (const c of [open, draft, unlisted, other, mine]) store.set(`card:${c.id}`, c);
  store.set(`cards-of:${from}`, [open.id, draft.id]);
  store.set(`cards-of:${OWNER}`, [mine.id]);
  store.set('pool', [open.id, unlisted.id, other.id]);
  store.set(`credits:${from}`, 3);
  store.set(`credits:${OWNER}`, 2);
  store.set('fusion-invite:old', { card_id: open.id, owner: from, status: 'open', created_at: NOW, expires_at: NOW + 86_400_000 });

  assert.equal((await registry.mergeGuest({ claim: 'nope', owner: OWNER }, NOW)).code, 'bad_claim');
  assert.equal((await registry.mergeGuest({ claim: 'c1', owner: from }, NOW)).code, 'bad_claim', 'not into itself');
  assert.deepEqual(await registry.mergeGuest({ claim: 'c1', owner: OWNER }, NOW + 1000), { ok: true, moved: 3, forget: [`card:${open.id}`, `card:${draft.id}`, `draft:${draft.id}`, `card:${unlisted.id}`] });
  assert.deepEqual(store.get(`cards-of:${OWNER}`), [open.id, draft.id, unlisted.id, mine.id]);
  assert.ok(!store.has(`cards-of:${from}`));
  for (const id of [open.id, draft.id, unlisted.id]) assert.equal((await registry.card(id)).owner, OWNER);
  // As on saving: out of matching, drafts from before failed, and someone else's card untouched.
  assert.deepEqual([(await registry.card(open.id)).matching, (await registry.card(unlisted.id)).matching], [{ open: false }, { open: false }]);
  assert.equal((await registry.card(draft.id)).status, 'failed');
  assert.deepEqual(store.get('pool'), [other.id]);
  assert.equal((await registry.card(other.id)).owner, 'user:someone');
  assert.deepEqual([await registry.credits(OWNER), await registry.credits(from)], [5, 0]);
  assert.equal(await registry.token('t1', NOW + 1000), null, 'the guest sign-in ended');
  assert.equal(await registry.claimable('c1', NOW + 1000), null, 'and its claim code is used up');
  assert.equal((await registry.mergeGuest({ claim: 'c1', owner: OWNER }, NOW + 2000)).code, 'bad_claim', 'once');
  assert.equal(await registry.fusionInvite('old', NOW + 2000), null, 'its fusion invites from before stop counting');
  assert.deepEqual([(await registry.user('g1')).guest, (await registry.user('g1')).merged_into], [false, OWNER]);
  // A sponsorship under way now credits the member, a draft refunded later cannot wait again, and a proof
  // the guest sign-in started puts no badge on the member's card.
  assert.equal((await registry.card(open.id)).sponsor.credited_to, OWNER);
  assert.equal((await registry.card(draft.id)).drafted_at, undefined);
  await registry.saveProof('p-guest', { card_id: open.id, owner: from, status: 'pending', created_at: NOW + 1500, expires_at: NOW + 1_800_000 });
  assert.deepEqual(await registry.finishProof('p-guest', { status: 'verified', badge: P1 }, 'jp', NOW + 2000), { ok: true, card: null });
  assert.equal((await registry.card(open.id)).badge, undefined);

  // A guest with a fused card is refused, untouched, to be saved instead.
  assert.ok((await registry.createGuest(guestOf(2), NOW)).ok);
  const fused = card('f', { owner: 'user:friend', co_owner: 'user:g2', kind: 'fusion' });
  store.set(`card:${fused.id}`, fused);
  store.set('cards-of:user:g2', [fused.id]);
  assert.equal((await registry.mergeGuest({ claim: 'c2', owner: OWNER }, NOW)).code, 'has_fusions');
  assert.ok(await registry.token('t2', NOW));
  assert.ok(await registry.claimable('c2', NOW));
  assert.equal((await registry.card(fused.id)).co_owner, 'user:g2');
});

test('revoking an event code takes its unsaved guests’ cards out of matching', async () => {
  const { registry, store } = memoryRegistry();
  await registry.createInvites([{ hash: 'event', label: 'frontiers', uses: 5 }], NOW, { event: true, expires_at: NOW + 86_400_000 });
  await registry.createInvites([{ hash: 'other', label: 'elsewhere', uses: 5 }], NOW, { event: true, expires_at: NOW + 86_400_000 });
  const guest = (n, invite) => registry.createGuest({ invite, user: { id: `g${n}`, handle: `zkads-g${n}` }, token: { hash: `t${n}`, record: { owner: `user:g${n}`, label: 'Claude', scope: 'agent', created_at: NOW, expires_at: NOW + 30 * 86_400_000 } }, claim: `c${n}` }, NOW);
  await guest(1, 'event');
  await guest(2, 'other');
  const card = (n, owner) => ({ id: `${n}`.repeat(20), owner, status: 'ready', files: [], matching: { open: true, until: NOW + 3_600_000 }, created_at: NOW, updated_at: NOW });
  const cards = [card(1, 'user:g1'), card(2, 'user:g2'), card(3, OWNER)];
  for (const c of cards) store.set(`card:${c.id}`, c);
  store.set('pool', cards.map((c) => c.id));
  assert.deepEqual(await registry.revokeInvite('event'), { revoked: true, forget: [`card:${cards[0].id}`] });
  assert.deepEqual((await registry.card(cards[0].id)).matching, { open: false });
  assert.deepEqual(store.get('pool'), [cards[1].id, cards[2].id], 'another code’s guest and a member stay');
  assert.deepEqual(await registry.revokeInvite('event'), { revoked: false, forget: [] });
});

test('"Make this one" makes each catalogue item once, for the card’s own account, and a guest’s counts toward its five', async () => {
  const { registry, store } = memoryRegistry();
  const id = await readyCard(registry, { concept: { product_name: 'X', era: 'Vienna, 1908', catalogue: [{ name: 'A', era: 'Rome, 50', teaser: 't' }, { name: 'B', teaser: 't' }] } });
  const card = (n) => ({ id: `k${String(n).padStart(19, 'a')}`, status: 'queued', files: [], job: `j${n}`, created_at: NOW, updated_at: NOW });
  const first = await registry.catalogueCard(id, 0, card(1), NOW, 5);
  assert.deepEqual([first.ok, first.card.owner, first.existing], [true, OWNER, undefined]);
  assert.deepEqual(first.card.write, { kind: 'catalogue', card: (await registry.card(id)).concept, item: { name: 'A', era: 'Rome, 50', teaser: 't' } }, 'written from the card the registry read');
  assert.equal((await registry.card(id)).made[0], card(1).id, 'recorded on the card in the same step');
  assert.deepEqual((await registry.cardsOf(OWNER)).map((c) => c.id), [card(1).id], 'listed for the same account');
  assert.equal((await registry.catalogueCard(id, 0, card(2), NOW, 5)).card.id, card(1).id, 'asking again finds the same card');
  assert.equal((await registry.capStatus(NOW)).used_today, 1);
  assert.equal((await registry.catalogueCard(id, 2, card(3), NOW, 5)).code, 'not_found');
  assert.equal((await registry.catalogueCard(id, 1, card(7), NOW, 5)).card.write.item.era, 'Vienna, 1908', 'an item without an era takes the card’s');
  assert.equal((await registry.catalogueCard('n'.repeat(20), 0, card(8), NOW, 5)).code, 'not_found');
  const parent = store.get(`card:${id}`);
  store.set(`card:${'w'.repeat(20)}`, { ...parent, id: 'w'.repeat(20), status: 'queued', rerender: false, made: undefined });
  assert.equal((await registry.catalogueCard('w'.repeat(20), 0, card(9), NOW, 5)).code, 'not_ready', 'a card still being made');
  assert.equal(store.get(`card:${'w'.repeat(20)}`).made, undefined, 'a refusal records nothing');
  store.set(`card:${'w'.repeat(20)}`, { ...store.get(`card:${'w'.repeat(20)}`), rerender: true });
  assert.ok((await registry.catalogueCard('w'.repeat(20), 0, card(10), NOW, 5)).ok, 'a ready card re-rendering (a badge, say) counts as ready');
  // A failed one can be made again.
  store.set(`card:${card(1).id}`, { ...store.get(`card:${card(1).id}`), status: 'failed' });
  assert.equal((await registry.catalogueCard(id, 0, card(4), NOW, 5)).card.id, card(4).id);
  // An unsaved guest's catalogue cards count toward its cards for the day.
  await registry.createInvites([{ hash: 'event', label: 'frontiers', uses: 5 }], NOW, { event: true, expires_at: NOW + 86_400_000 });
  await registry.createGuest({ invite: 'event', user: { id: 'g1', handle: 'zkads-g1' }, token: { hash: 't1', record: { owner: 'user:g1', scope: 'agent', created_at: NOW, expires_at: NOW + 86_400_000 } }, claim: 'c1' }, NOW);
  const guestCard = { ...store.get(`card:${id}`), id: 'q'.repeat(20), owner: 'user:g1', made: undefined };
  store.set(`card:${guestCard.id}`, guestCard);
  assert.ok((await registry.catalogueCard(guestCard.id, 0, card(5), NOW, 1)).ok);
  assert.equal((await registry.catalogueCard(guestCard.id, 1, card(6), NOW, 1)).code, 'guest_limit');
});

test('deleting a card removes it for its owners, from the pool and the follow-ups, and only they can', async () => {
  const { registry, store } = memoryRegistry();
  const id = await readyCard(registry, { co_owner: 'user:bo', matching: { open: true, until: NOW + 3_600_000 } });
  store.set(`cards-of:${OWNER}`, [id, 'x'.repeat(20)]);
  store.set('cards-of:user:bo', [id]);
  store.set('pool', [id, 'y'.repeat(20)]);
  store.set('follow-ups', [id]);
  assert.equal((await registry.deleteCard(id, 'user:eve')).code, 'not_found', 'not theirs');
  assert.ok(store.has(`card:${id}`));
  const cap = await registry.capStatus(NOW);
  assert.equal((await registry.deleteCard(id, 'user:bo')).card.id, id, 'either owner of a fused card can');
  assert.deepEqual(await registry.capStatus(NOW), cap, 'nothing is refunded');
  assert.deepEqual([store.has(`card:${id}`), store.get(`cards-of:${OWNER}`), store.get('cards-of:user:bo'), store.get('pool'), store.get('follow-ups')], [false, ['x'.repeat(20)], [], ['y'.repeat(20)], []]);
  assert.equal((await registry.deleteCard(id, OWNER)).code, 'not_found', 'already gone');
});
