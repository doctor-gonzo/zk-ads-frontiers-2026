import { DurableObject } from 'cloudflare:workers';
import { FAKE_BRANDS, FAKE_BUDGET } from '../lib/brands.mjs';

// One instance holds ZKAds' records: the daily cap and today's count, cards,
// members and their passkeys, invite codes, tokens, and agent sign-in codes.
// A method's storage calls run without other requests interleaving (Durable
// Object input gates), so the cap cannot be overrun, an invite cannot be used
// twice, and a card record is checked and updated in one step. (An upload's
// R2 write happens between two such steps; only the card's own renderer holds
// its job token, so that gap can only mix files from that card's renders.)
//
// Short-lived records (passkey ceremonies, sign-in codes, rate counters,
// tokens, fusion invites and their sign-up halves, event codes, guest
// accounts' claim codes, proof sessions) carry expires_at; reads ignore
// expired ones and an hourly alarm deletes them.
const EXPIRING = ['ceremony:', 'device:', 'usercode:', 'rate:', 'token:', 'fusion-invite:', 'invite:', 'claim:', 'proof:'];
const MAX_PENDING_BRANDS = 30;
// What a change a person (or an admin) starts begins with: no old error and
// its own follow-up renders.
const FRESH_CHANGE = { last_error: null, change_undone: false, follow_up_tries: 0, follow_up_after: null };
const MAX_LISTED_CARDS = 100;
const MAX_TOKENS_PER_OWNER = 50;
const MAX_POOL = 1000;
const MAX_LISTED_FUSIONS = 100;

export class Registry extends DurableObject {
  async capStatus(now) {
    const day = dayKey(now);
    const config = (await this.ctx.storage.get('config')) ?? {};
    const used = (await this.ctx.storage.get(`used:${day}`)) ?? 0;
    return { cards_per_day: config.cards_per_day ?? defaultCap(this.env), used_today: used, day };
  }

  async setCap(cardsPerDay, now) {
    const config = (await this.ctx.storage.get('config')) ?? {};
    await this.ctx.storage.put('config', { ...config, cards_per_day: cardsPerDay });
    return this.capStatus(now);
  }

  async saveToken(hash, record) {
    await this.#putExpiring(`token:${hash}`, record);
    await this.#indexToken(record.owner, hash);
  }

  // A guest's sign-in also needs its event code: revoking the code ends it.
  async token(hash, now) {
    const record = await this.#fresh(`token:${hash}`, now);
    return record?.event && !(await this.ctx.storage.get(`invite:${record.event}`)) ? null : record;
  }

  async deleteToken(hash) {
    const record = await this.ctx.storage.get(`token:${hash}`);
    await this.ctx.storage.delete(`token:${hash}`);
    if (record?.owner) {
      const key = `tokens-of:${record.owner}`;
      const hashes = (await this.ctx.storage.get(key)) ?? [];
      await this.ctx.storage.put(key, hashes.filter((h) => h !== hash));
    }
  }

  // The owner's live tokens, newest first, without their hashes' full value.
  async tokensOf(owner, now) {
    const hashes = (await this.ctx.storage.get(`tokens-of:${owner}`)) ?? [];
    const records = await this.ctx.storage.get(hashes.map((hash) => `token:${hash}`));
    return hashes
      .map((hash) => ({ hash, record: records.get(`token:${hash}`) }))
      .filter(({ record }) => record && record.expires_at > now)
      .map(({ hash, record }) => ({ id: hash.slice(0, 12), label: record.label, scope: record.scope, created_at: record.created_at, expires_at: record.expires_at }));
  }

  // Revokes the owner's token whose hash starts with `id` (from tokensOf).
  async revokeToken(owner, id) {
    const hashes = (await this.ctx.storage.get(`tokens-of:${owner}`)) ?? [];
    const hash = hashes.find((h) => h.startsWith(id));
    if (!hash || id.length < 12) return false;
    await this.ctx.storage.delete(`token:${hash}`);
    await this.ctx.storage.put(`tokens-of:${owner}`, hashes.filter((h) => h !== hash));
    return true;
  }

  async revokeAll(owner) {
    const revoked = await this.#revokeTokens(owner);
    // Nobody can act for an unsaved guest account now: its way back in goes
    // too, its cards leave matching, and the worker has the enclave delete
    // their summaries (returned as `forget`).
    const user = owner.startsWith('user:') ? await this.user(owner.slice(5)) : null;
    if (!user?.guest) return { revoked, forget: [] };
    if (user.claim) await this.ctx.storage.delete(`claim:${user.claim}`);
    const { pool, cards } = await this.#poolRecords();
    const listed = (await this.ctx.storage.get(`cards-of:${owner}`)) ?? [];
    const own = [...cards.filter((card) => card.owner === owner)];
    for (let i = 0; i < listed.length; i += 128) for (const card of (await this.ctx.storage.get(listed.slice(i, i + 128).map((id) => `card:${id}`))).values()) if (!own.some((c) => c.id === card.id)) own.push(card);
    await this.#closeMatching(own.filter((card) => card.matching?.open), pool);
    return { revoked, forget: own.flatMap((card) => [`card:${card.id}`, ...(card.write?.kind === 'summary' ? [`draft:${card.id}`] : [])]) };
  }

  // Whether a guest's sign-in (`token`, its hash) still holds; a write a
  // guest started checks it again in the same step, so a request that passed
  // it before the sign-in ended (the account saved, its code revoked)
  // changes nothing. Without a token there is nothing to check.
  async #signedIn(token, now) {
    return !token || Boolean(await this.token(token, now));
  }

  // The pool's ids and its cards' records.
  async #poolRecords() {
    const pool = (await this.ctx.storage.get('pool')) ?? [];
    const cards = [];
    // The storage API reads at most 128 keys per call.
    for (let i = 0; i < pool.length; i += 128) cards.push(...(await this.ctx.storage.get(pool.slice(i, i + 128).map((id) => `card:${id}`))).values());
    return { pool, cards };
  }

  // Takes these cards out of matching and the pool.
  async #closeMatching(cards, pool) {
    for (let i = 0; i < cards.length; i += 100) await this.ctx.storage.put(Object.fromEntries(cards.slice(i, i + 100).map((card) => [`card:${card.id}`, { ...card, matching: { open: false } }])));
    if (cards.length) await this.ctx.storage.put('pool', pool.filter((id) => !cards.some((card) => card.id === id)));
  }

  async #revokeTokens(owner) {
    const hashes = (await this.ctx.storage.get(`tokens-of:${owner}`)) ?? [];
    for (let i = 0; i < hashes.length; i += 128) await this.ctx.storage.delete(hashes.slice(i, i + 128).map((hash) => `token:${hash}`));
    await this.ctx.storage.delete(`tokens-of:${owner}`);
    return hashes.length;
  }

  // Every live token stays listed (so it can be seen and revoked): dead
  // entries are dropped first, and past the limit the oldest token is revoked.
  async #indexToken(owner, hash) {
    const key = `tokens-of:${owner}`;
    const hashes = [hash, ...((await this.ctx.storage.get(key)) ?? []).filter((h) => h !== hash)];
    const records = await this.ctx.storage.get(hashes.map((h) => `token:${h}`));
    const now = Date.now();
    const live = hashes.filter((h) => h === hash || records.get(`token:${h}`)?.expires_at > now);
    const evicted = live.slice(MAX_TOKENS_PER_OWNER);
    if (evicted.length) await this.ctx.storage.delete(evicted.map((h) => `token:${h}`));
    await this.ctx.storage.put(key, live.slice(0, MAX_TOKENS_PER_OWNER));
  }

  // Fixed windows: at most `limit` hits per window for this key.
  async hit(key, limit, windowMs, now) {
    const row = await this.#fresh(`rate:${key}`, now);
    if (row && row.count >= limit) return false;
    await this.#putExpiring(`rate:${key}`, { count: (row?.count ?? 0) + 1, expires_at: row?.expires_at ?? now + windowMs });
    return true;
  }

  // Takes one of today's slots and stores the card, or refuses at the cap. A
  // fused card is listed for both of its owners. A guest's card also takes
  // one of its `guestCards` a day, given back with the slot (see refund).
  async createCard(card, now, guestCards = 0, token = null, extra = {}) {
    if (!(await this.#signedIn(token, now))) return { ok: false, code: 'signed_out' };
    const { cards_per_day, used_today, day } = await this.capStatus(now);
    if (used_today >= cards_per_day) return { ok: false, code: 'daily_cap', cap: cards_per_day };
    const slot = guestCards ? await this.#guestSlot(card.owner, guestCards, now) : {};
    if (!slot) return { ok: false, code: 'guest_limit' };
    const writes = { ...extra, ...slot, [`used:${day}`]: used_today + 1, [`card:${card.id}`]: { ...card, guest_slot: Object.keys(slot)[0] ?? null } };
    for (const owner of [card.owner, card.co_owner].filter(Boolean)) {
      const list = (await this.ctx.storage.get(`cards-of:${owner}`)) ?? [];
      writes[`cards-of:${owner}`] = [card.id, ...list].slice(0, MAX_LISTED_CARDS);
    }
    await this.ctx.storage.put(writes);
    if (guestCards) await this.#ensureAlarm();
    return { ok: true };
  }

  // "Make this one" (asked by the card's owner or co-owner): a card from item
  // `item` of a card's catalogue, for that card's own account (so a guest's
  // comes along when it is saved), counted like any card: a guest asking (who
  // can only be the owner) spends one of its `guestCards` a day, its sign-in,
  // `token`, checked again here. Each item is made once: asking again returns
  // that card, unless it failed.
  async catalogueCard(parentId, item, base, now, guestCards = 0, token = null) {
    const parent = await this.card(parentId);
    if (!parent) return { ok: false, code: 'not_found' };
    const earlier = parent.made?.[item] ? await this.card(parent.made[item]) : null;
    if (earlier && earlier.status !== 'failed') return { ok: true, card: earlier, existing: true };
    // A ready card, or one re-rendering (a badge, say) with its concept.
    if (!parent.concept || (parent.status !== 'ready' && !parent.rerender)) return { ok: false, code: 'not_ready' };
    const idea = parent.concept.catalogue?.[item];
    if (!idea) return { ok: false, code: 'not_found' };
    const card = {
      ...base,
      owner: parent.owner,
      ...(parent.co_owner ? { co_owner: parent.co_owner } : {}),
      // An item without an era takes the card's.
      write: { kind: 'catalogue', card: parent.concept, item: { name: idea.name, era: idea.era || parent.concept.era, teaser: idea.teaser ?? '' } },
    };
    const created = await this.createCard(card, now, guestCards, token, { [`card:${parentId}`]: { ...parent, made: { ...parent.made, [item]: card.id } } });
    if (!created.ok) return created;
    return { ok: true, card: await this.card(card.id) };
  }

  // The write that takes one of a guest's cards for the day (a fixed window
  // from its first), or null if it has none left.
  async #guestSlot(owner, limit, now) {
    const key = `rate:guest-cards:${owner}`;
    const row = await this.#fresh(key, now);
    if (row && row.count >= limit) return null;
    return { [key]: { count: (row?.count ?? 0) + 1, expires_at: row?.expires_at ?? now + 86_400_000 } };
  }

  // Brands: the fictional roster (added on first use) and admitted bids.
  async brands() {
    if (!(await this.ctx.storage.get('brands-seeded'))) {
      const now = Date.now();
      const seeded = FAKE_BRANDS.map((brand) => ({ ...brand, id: brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), budget: FAKE_BUDGET, spent: 0, wins: 0, status: 'active', fictional: true, created_at: now }));
      await this.ctx.storage.put({ ...Object.fromEntries(seeded.map((brand) => [`brand:${brand.id}`, brand])), brands: seeded.map((brand) => brand.id), 'brands-seeded': true });
    }
    const ids = (await this.ctx.storage.get('brands')) ?? [];
    const found = await this.ctx.storage.get(ids.map((id) => `brand:${id}`));
    return ids.map((id) => found.get(`brand:${id}`)).filter(Boolean);
  }

  // At most 100 live brands; three waiting for review per member, and 30 in all.
  async addBrand(brand) {
    const all = await this.brands();
    const pending = all.filter((b) => b.status === 'pending');
    if (pending.filter((b) => b.owner === brand.owner).length >= 3) return 'pending';
    if (pending.length >= MAX_PENDING_BRANDS) return 'queue';
    if (all.filter((b) => b.status === 'active' || b.status === 'pending').length >= 100) return false;
    await this.ctx.storage.put({ [`brand:${brand.id}`]: brand, brands: [...all.map((b) => b.id), brand.id] });
    return true;
  }

  async removeBrand(id) {
    const brand = await this.ctx.storage.get(`brand:${id}`);
    if (!brand) return null;
    const ids = (await this.ctx.storage.get('brands')) ?? [];
    await this.ctx.storage.delete(`brand:${id}`);
    await this.ctx.storage.put('brands', ids.filter((x) => x !== id));
    return brand;
  }

  async setBrandStatus(id, status) {
    const brand = await this.ctx.storage.get(`brand:${id}`);
    if (!brand) return null;
    const next = { ...brand, status };
    await this.ctx.storage.put(`brand:${id}`, next);
    return next;
  }

  // Settles a won slot in one step: the brand pays, the owner earns credits,
  // and the card takes the sponsored item and a new job to re-render.
  async sponsor(id, owner, sponsor, job, now) {
    const card = await this.card(id);
    if (!card || ![card.owner, card.co_owner].includes(owner) || card.sponsor || card.status !== 'ready') return { ok: false, code: 'not_ready', message: 'Only a ready card without a sponsor can take one.' };
    const brand = await this.ctx.storage.get(`brand:${sponsor.brand_id}`);
    if (!brand || brand.status !== 'active' || brand.budget - brand.spent < sponsor.price) return { ok: false, code: 'brand_gone', message: 'The winning brand has run out of credits. Try again.' };
    const credits = (await this.ctx.storage.get(`credits:${owner}`)) ?? 0;
    // Unsettled until the re-render succeeds; a failed one refunds both sides.
    const next = { ...card, ...FRESH_CHANGE, sponsor: { ...sponsor, unsettled: true, credited_to: owner }, status: 'queued', step: null, error: null, job, rerender: true, updated_at: now };
    await this.ctx.storage.put({
      [`brand:${brand.id}`]: { ...brand, spent: brand.spent + sponsor.price, wins: (brand.wins ?? 0) + 1 },
      [`credits:${owner}`]: credits + sponsor.credits,
      [`card:${id}`]: next,
    });
    return { ok: true, card: next };
  }

  // Changes how a ready card looks (its badge) and queues a re-render, in one
  // step. What it replaces is kept, so a failed render can put it back.
  async restyle(id, owner, patch, job, now) {
    const card = await this.card(id);
    if (!card || ![card.owner, card.co_owner].includes(owner)) return { ok: false, code: 'not_found', message: 'No such card of yours.' };
    if (card.status !== 'ready') return { ok: false, code: 'not_ready', message: 'Wait until the card is ready.' };
    // Numbers from logs never replace a badge backed by a proof.
    if (patch.badge?.source === 'logs' && card.badge && card.badge.source !== 'logs') return { ok: false, code: 'proved', message: 'This card has a proved badge, which is kept.' };
    const before = Object.fromEntries(Object.keys(patch).map((key) => [key, card[key] ?? null]));
    const next = { ...card, ...FRESH_CHANGE, ...patch, before, status: 'queued', step: null, error: null, job, rerender: true, updated_at: now };
    await this.ctx.storage.put(`card:${id}`, next);
    return { ok: true, card: next };
  }

  // Queues the render that brings a ready card's page in line with its record
  // (see #putReady), counting it, unless the page has caught up meanwhile.
  async queueFollowUp(id, job, now) {
    const card = await this.card(id);
    if (!card || card.status !== 'ready' || !pageBehind(card) || (card.follow_up_tries ?? 0) >= 2) return { ok: false };
    const next = { ...card, status: 'queued', step: null, error: null, job, rerender: true, follow_up_tries: (card.follow_up_tries ?? 0) + 1, follow_up_after: null, updated_at: now };
    await this.ctx.storage.put(`card:${id}`, next);
    return { ok: true, card: next };
  }

  // Cards whose follow-up render is due: ones the worker could not send at
  // once (the renderer was unreachable), for its scheduled sweep. Cards no
  // longer waiting drop off the list.
  async dueFollowUps(now) {
    const ids = (await this.ctx.storage.get('follow-ups')) ?? [];
    const cards = new Map();
    // The storage API reads at most 128 keys per call.
    for (let i = 0; i < ids.length; i += 128) for (const [key, card] of await this.ctx.storage.get(ids.slice(i, i + 128).map((id) => `card:${id}`))) cards.set(key, card);
    const waiting = ids.filter((id) => cards.get(`card:${id}`)?.follow_up_after);
    if (waiting.length !== ids.length) await this.ctx.storage.put('follow-ups', waiting);
    return waiting.filter((id) => cards.get(`card:${id}`).follow_up_after <= now);
  }

  // A proof session for a card's Codex badge (30 minutes, used once).
  async saveProof(session, record) {
    await this.#putExpiring(`proof:${session}`, record);
  }

  async proof(session, now) {
    return this.#fresh(`proof:${session}`, now);
  }

  // Records the enclave's verdict on a pending proof; a proved badge goes on
  // the card (re-rendered now if it is ready; mid-render, the render after the
  // current one puts it on the page, see #putReady).
  async finishProof(session, result, job, now) {
    const proof = await this.#fresh(`proof:${session}`, now);
    if (!proof || proof.status !== 'pending') return { ok: false };
    // One started before its guest account was saved came from whoever held the guest sign-in then.
    const owner = proof.owner?.startsWith('user:') ? await this.user(proof.owner.slice(5)) : null;
    if (result.status === 'verified' && owner?.claimed_at && !(proof.created_at >= owner.claimed_at)) result = { status: 'failed', error: 'This proof was started before the account was saved. Start a new one.' };
    await this.ctx.storage.put(`proof:${session}`, { ...proof, status: result.status, badge: result.badge ?? null, error: result.error ?? null });
    if (result.status !== 'verified') return { ok: true, card: null };
    const card = await this.card(proof.card_id);
    if (!card) return { ok: true, card: null };
    const ready = card.status === 'ready';
    // A new proof gets its own follow-up renders, and a failed render keeps it.
    const badge = { ...FRESH_CHANGE, badge: result.badge, before: null };
    const next = ready ? { ...card, ...badge, status: 'queued', step: null, error: null, job, rerender: true, updated_at: now } : { ...card, ...badge };
    await this.ctx.storage.put(`card:${card.id}`, next);
    return { ok: true, card: ready ? next : null };
  }

  async credits(owner) {
    return (await this.ctx.storage.get(`credits:${owner}`)) ?? 0;
  }

  // A card waiting for its owner's summary: listed, but not yet counted. At
  // most `max` drafts under a day old wait at once.
  async createDraft(card, max, now, token = null) {
    if (!(await this.#signedIn(token, now))) return { ok: false, code: 'signed_out' };
    const list = (await this.ctx.storage.get(`cards-of:${card.owner}`)) ?? [];
    const cards = await this.ctx.storage.get(list.slice(0, MAX_LISTED_CARDS).map((id) => `card:${id}`));
    const waiting = [...cards.values()].filter((c) => c.status === 'waiting_summary' && now - c.created_at < 86_400_000).length;
    if (waiting >= max) return { ok: false, code: 'drafts_waiting' };
    await this.ctx.storage.put({ [`card:${card.id}`]: card, [`cards-of:${card.owner}`]: [card.id, ...list].slice(0, MAX_LISTED_CARDS) });
    return { ok: true };
  }

  // Takes today's slot (and a guest's daily card) for a waiting card and
  // queues it, in one step.
  async startDraft(id, owner, job, now, guestCards = 0, token = null) {
    if (!(await this.#signedIn(token, now))) return { ok: false, code: 'signed_out' };
    const card = await this.card(id);
    if (!card || card.owner !== owner || card.status !== 'waiting_summary' || now - card.created_at >= 86_400_000) return { ok: false, code: 'not_waiting' };
    // A draft from before a guest account was saved is not started after it:
    // its summary may be whoever held the guest sign-in's.
    const user = owner.startsWith('user:') ? await this.user(owner.slice(5)) : null;
    if (user?.claimed_at && card.created_at < user.claimed_at) return { ok: false, code: 'stale_draft' };
    const { cards_per_day, used_today, day } = await this.capStatus(now);
    if (used_today >= cards_per_day) return { ok: false, code: 'daily_cap', cap: cards_per_day };
    const slot = guestCards ? await this.#guestSlot(owner, guestCards, now) : {};
    if (!slot) return { ok: false, code: 'guest_limit' };
    const next = { ...card, status: 'queued', job, created_at: now, drafted_at: card.created_at, guest_slot: Object.keys(slot)[0] ?? null, updated_at: now };
    await this.ctx.storage.put({ ...slot, [`used:${day}`]: used_today + 1, [`card:${id}`]: next });
    if (guestCards) await this.#ensureAlarm();
    return { ok: true, card: next };
  }

  // Opens a card to matching until `until`, or closes it (until = null).
  // Opening checks the sign-in (`token`, its hash) again here, in the same
  // step as the write: a request that passed it before the sign-in ended (a
  // guest account saved meanwhile) opens nothing.
  async setMatching(id, owner, until, token = null) {
    const card = await this.card(id);
    if (!card || ![card.owner, card.co_owner].includes(owner)) return null;
    if (until && token && !(await this.token(token, Date.now()))) return null;
    const pool = (await this.ctx.storage.get('pool')) ?? [];
    const next = { ...card, matching: until ? { open: true, until } : { open: false } };
    await this.ctx.storage.put({ [`card:${id}`]: next, pool: until ? [id, ...pool.filter((x) => x !== id)].slice(0, MAX_POOL) : pool.filter((x) => x !== id) });
    return next;
  }

  // Ready cards currently open to matching; lapsed ones leave the pool.
  async poolCards(now) {
    const pool = (await this.ctx.storage.get('pool')) ?? [];
    const cards = [];
    for (let i = 0; i < pool.length; i += 128) {
      const batch = await this.ctx.storage.get(pool.slice(i, i + 128).map((id) => `card:${id}`));
      cards.push(...batch.values());
    }
    const open = cards.filter((card) => card.matching?.open && card.matching.until > now);
    if (open.length !== pool.length) await this.ctx.storage.put('pool', open.map((card) => card.id));
    return open.filter((card) => card.status === 'ready');
  }

  async createFusion(fusion) {
    await this.ctx.storage.put(`fusion:${fusion.id}`, fusion);
    await this.#indexFusion(fusion);
  }

  async fusion(id) {
    return (await this.ctx.storage.get(`fusion:${id}`)) ?? null;
  }

  // Moves a fusion on only from the status the caller saw, so two accepts
  // (or an accept and a decline) cannot both win.
  async advanceFusion(id, from, patch) {
    const fusion = await this.fusion(id);
    if (!fusion || fusion.status !== from) return null;
    const next = { ...fusion, ...patch };
    await this.ctx.storage.put(`fusion:${id}`, next);
    return next;
  }

  async fusionsOf(owner) {
    const ids = (await this.ctx.storage.get(`fusions-of:${owner}`)) ?? [];
    const found = await this.ctx.storage.get(ids.map((id) => `fusion:${id}`));
    return ids.map((id) => found.get(`fusion:${id}`)).filter(Boolean);
  }

  async #indexFusion(fusion) {
    for (const owner of [fusion.a.owner, fusion.b.owner].filter(Boolean)) {
      const list = (await this.ctx.storage.get(`fusions-of:${owner}`)) ?? [];
      await this.ctx.storage.put(`fusions-of:${owner}`, [fusion.id, ...list.filter((id) => id !== fusion.id)].slice(0, MAX_LISTED_FUSIONS));
    }
  }

  // A member's fusion invite also lets one newcomer join, until it is
  // claimed or expires. A guest's (`viaEvent`, its event code's hash) does so
  // only while that code is open, and spends one of its uses (see register).
  async createFusionInvite(hash, record, now, joins, viaEvent = null, token = null) {
    if (!(await this.#signedIn(token, now))) return false;
    await this.#putExpiring(`fusion-invite:${hash}`, record);
    if (joins) await this.ctx.storage.put(`invite:${hash}`, { label: 'fusion invite', uses_left: 1, created_at: now, expires_at: record.expires_at, ...(viaEvent ? { via_event: viaEvent } : {}) });
    return true;
  }

  async fusionInvite(hash, now) {
    const invite = await this.#fresh(`fusion-invite:${hash}`, now);
    return invite && !(await this.#madeBeforeSaving(invite)) ? invite : null;
  }

  // An invite made before its guest account was saved came from whoever held
  // the guest sign-in then, so it no longer counts.
  async #madeBeforeSaving(invite) {
    const inviter = invite.owner?.startsWith('user:') ? await this.user(invite.owner.slice(5)) : null;
    return Boolean(inviter?.claimed_at && !(invite.created_at >= inviter.claimed_at));
  }

  // The friend claims the invite: it is used up and the fusion exists, together.
  async claimFusionInvite(hash, friend, fusion, now) {
    const invite = await this.#fresh(`fusion-invite:${hash}`, now);
    if (!invite || invite.status !== 'open') return { ok: false, code: 'used', message: 'This fusion invite was already used or has expired.' };
    if (invite.owner === friend) return { ok: false, code: 'own_invite', message: 'This is your own invite. Send it to someone else.' };
    if (await this.#madeBeforeSaving(invite)) return { ok: false, code: 'used', message: 'This fusion invite was already used or has expired.' };
    await this.ctx.storage.put({ [`fusion-invite:${hash}`]: { ...invite, status: 'used', used_by: friend }, [`fusion:${fusion.id}`]: fusion });
    // Its sign-up half, if still unused, goes with it.
    await this.ctx.storage.delete(`invite:${hash}`);
    await this.#indexFusion(fusion);
    return { ok: true };
  }

  async cardsOf(owner) {
    const ids = (await this.ctx.storage.get(`cards-of:${owner}`)) ?? [];
    const cards = await this.ctx.storage.get(ids.map((id) => `card:${id}`));
    return ids.map((id) => cards.get(`card:${id}`)).filter(Boolean);
  }

  // An event code (`event`) also starts guest accounts; `expires_at` is optional.
  async createInvites(invites, now, { event = false, expires_at = null } = {}) {
    const extra = { ...(event ? { event: true } : {}), ...(expires_at ? { expires_at } : {}) };
    await this.ctx.storage.put(Object.fromEntries(invites.map(({ hash, label, uses }) => [`invite:${hash}`, { label, uses_left: uses, created_at: now, ...extra }])));
    if (expires_at) await this.#ensureAlarm();
  }

  async inviteUsable(hash) {
    const now = Date.now();
    const invite = await this.ctx.storage.get(`invite:${hash}`);
    if (!invite || invite.uses_left <= 0 || invite.expires_at <= now) return false;
    return !invite.via_event || Boolean(await this.#openEvent(invite.via_event, now));
  }

  // An event code's record, if it can still let someone in.
  async #openEvent(hash, now) {
    const event = await this.ctx.storage.get(`invite:${hash}`);
    return event && event.uses_left > 0 && !(event.expires_at <= now) ? event : null;
  }

  // Revoking an event code also ends its unsaved guests (see token,
  // claimable), and takes their cards out of matching, since nobody can do
  // that for them now; the worker has the enclave delete the summaries
  // (returned as `forget`).
  // (The code itself goes last, so a failure on the way can be retried.)
  async revokeInvite(hash) {
    const invite = await this.ctx.storage.get(`invite:${hash}`);
    let closed = [];
    if (invite?.event) {
      const { pool, cards } = await this.#poolRecords();
      const owners = [...new Set(cards.map((card) => card.owner).filter((owner) => owner?.startsWith('user:')))];
      const guests = new Set();
      for (let i = 0; i < owners.length; i += 128) for (const [key, user] of await this.ctx.storage.get(owners.slice(i, i + 128).map((owner) => `user:${owner.slice(5)}`))) if (user.guest && user.event === hash) guests.add(`user:${key.slice(5)}`);
      closed = cards.filter((card) => guests.has(card.owner));
      await this.#closeMatching(closed, pool);
    }
    await this.ctx.storage.delete(`invite:${hash}`);
    return { revoked: Boolean(invite), forget: closed.map((card) => `card:${card.id}`) };
  }

  // One use of an event code starts a guest account: the account (no passkey
  // yet), its assistant's token, and the claim code with which the person
  // adds a passkey later, all together. The guest lasts while the code does
  // (revoking the code ends it), and at most as long as the token would.
  async createGuest({ invite: inviteHash, user, token, claim }, now) {
    const invite = await this.ctx.storage.get(`invite:${inviteHash}`);
    if (!invite || invite.uses_left <= 0 || invite.expires_at <= now) return { ok: false, code: 'bad_code', message: 'That event code is not valid, has expired or has been used up.' };
    if (!invite.event) return { ok: false, code: 'not_event_code', message: 'That is an invite code, not an event code: it is for joining ZKAds with a passkey. (Assistants: use the sign-in code steps in skill.md.)' };
    const expires = Math.min(token.record.expires_at, invite.expires_at ?? Infinity);
    await this.ctx.storage.put({
      [`invite:${inviteHash}`]: { ...invite, uses_left: invite.uses_left - 1 },
      [`user:${user.id}`]: { ...user, guest: true, claim, event: inviteHash, invite: invite.label, created_at: now },
      [`token:${token.hash}`]: { ...token.record, event: inviteHash, expires_at: expires },
      [`claim:${claim}`]: { user_id: user.id, event: inviteHash, expires_at: expires },
    });
    await this.#indexToken(token.record.owner, token.hash);
    await this.#ensureAlarm();
    return { ok: true, expires_at: expires };
  }

  // The guest account a live claim code would save.
  async claimable(claim, now) {
    const record = await this.#fresh(`claim:${claim}`, now);
    if (!record || (record.event && !(await this.ctx.storage.get(`invite:${record.event}`)))) return null;
    const user = await this.user(record.user_id);
    return user?.guest ? user : null;
  }

  // The person saves a guest account with a passkey: the claim code is used
  // up, and the passkey, a session and the account's new standing are stored
  // together; its cards stay where they are. Every guest sign-in on it ends,
  // and nothing sealed before carries over: its cards leave matching (those
  // listed for it and any in the pool), its drafts from before fail
  // (startDraft refuses any missed), its fusion invites from before are
  // refused (claimFusionInvite), and the worker has the enclave delete their
  // summaries (returned as `forget`). So whoever held a sign-in (a planted
  // account's maker, say) keeps nothing. The person's assistant signs in
  // again, approved from the saved account.
  async claimGuest({ claim, credential, session }, now) {
    const owner = session.record.owner;
    const user = await this.claimable(claim, now);
    if (!user || owner !== `user:${user.id}`) return { ok: false, code: 'bad_claim', message: 'This account has already been saved (if that was you just now, sign in with your passkey), or the link has expired.' };
    if (await this.ctx.storage.get(`cred:${credential.id}`)) return { ok: false, code: 'duplicate', message: 'This passkey already belongs to a member. Sign in instead.' };
    // (The claim code goes last, so a failure on the way leaves the account still to save.)
    await this.#revokeTokens(owner);
    const pool = (await this.ctx.storage.get('pool')) ?? [];
    const ids = [...new Set([...((await this.ctx.storage.get(`cards-of:${owner}`)) ?? []), ...pool])];
    const cards = [];
    // The storage API reads at most 128 keys per call.
    for (let i = 0; i < ids.length; i += 128) for (const card of (await this.ctx.storage.get(ids.slice(i, i + 128).map((id) => `card:${id}`))).values()) if ([card.owner, card.co_owner].includes(owner)) cards.push(card);
    const closed = cards.filter((card) => card.matching?.open);
    const changed = cards
      .filter((card) => card.matching?.open || card.status === 'waiting_summary')
      .map((card) => ({ ...card, ...(card.matching?.open ? { matching: { open: false } } : {}), ...(card.status === 'waiting_summary' ? { status: 'failed', error: 'This draft was made before the account was saved. Make a new one.' } : {}) }));
    for (let i = 0; i < changed.length; i += 100) await this.ctx.storage.put(Object.fromEntries(changed.slice(i, i + 100).map((card) => [`card:${card.id}`, card])));
    const { claim: _used, ...saved } = user;
    await this.ctx.storage.put({
      ...(closed.length ? { pool: pool.filter((id) => !closed.some((card) => card.id === id)) } : {}),
      [`user:${user.id}`]: { ...saved, guest: false, claimed_at: now },
      [`cred:${credential.id}`]: { ...credential, user_id: user.id },
      [`token:${session.hash}`]: session.record,
    });
    await this.ctx.storage.delete(`claim:${claim}`);
    await this.#indexToken(owner, session.hash);
    await this.#ensureAlarm();
    return { ok: true, forget: cards.flatMap((card) => [`card:${card.id}`, ...(card.write?.kind === 'summary' ? [`draft:${card.id}`] : [])]) };
  }

  async saveCeremony(id, record) {
    await this.#putExpiring(`ceremony:${id}`, record);
  }

  // A passkey ceremony is used once, even when its verification then fails.
  async takeCeremony(id, now) {
    const record = await this.#fresh(`ceremony:${id}`, now);
    if (record) await this.ctx.storage.delete(`ceremony:${id}`);
    return record;
  }

  // Spends one use of the invite and creates the member, their passkey and a
  // session together, so a used-up invite can never make an account.
  async register({ invite: inviteHash, user, credential, session }, now) {
    const invite = await this.ctx.storage.get(`invite:${inviteHash}`);
    const event = invite?.via_event ? await this.#openEvent(invite.via_event, now) : null;
    if (!invite || invite.uses_left <= 0 || invite.expires_at <= now || (invite.via_event && !event)) return { ok: false, code: 'bad_invite', message: 'That invite code has been used up or has expired.' };
    if (await this.ctx.storage.get(`cred:${credential.id}`)) return { ok: false, code: 'duplicate', message: 'This passkey already belongs to a member. Sign in instead.' };
    await this.ctx.storage.put({
      ...(event ? { [`invite:${invite.via_event}`]: { ...event, uses_left: event.uses_left - 1 } } : {}),
      [`invite:${inviteHash}`]: { ...invite, uses_left: invite.uses_left - 1 },
      [`user:${user.id}`]: { ...user, invite: invite.label, created_at: now },
      [`cred:${credential.id}`]: { ...credential, user_id: user.id },
      [`token:${session.hash}`]: session.record,
    });
    await this.#indexToken(session.record.owner, session.hash);
    await this.#ensureAlarm();
    return { ok: true };
  }

  async credential(id) {
    return (await this.ctx.storage.get(`cred:${id}`)) ?? null;
  }

  async login({ credentialId, counter, session }) {
    const credential = await this.credential(credentialId);
    if (!credential) return null;
    await this.ctx.storage.put({ [`cred:${credentialId}`]: { ...credential, counter }, [`token:${session.hash}`]: session.record });
    await this.#indexToken(session.record.owner, session.hash);
    await this.#ensureAlarm();
    return this.user(credential.user_id);
  }

  async user(id) {
    return (await this.ctx.storage.get(`user:${id}`)) ?? null;
  }

  // Agent sign-in (a device code): the agent holds a secret code, the person
  // approves the short user code on the signed-in site.
  async startDevice({ hash, userCode, agentName, expiresAt }) {
    if (await this.#fresh(`usercode:${userCode}`, Date.now())) return false;
    await this.ctx.storage.put({
      [`device:${hash}`]: { user_code: userCode, agent_name: agentName, status: 'pending', created_at: Date.now(), polls: 0, expires_at: expiresAt },
      [`usercode:${userCode}`]: { device: hash, expires_at: expiresAt },
    });
    await this.#ensureAlarm();
    return true;
  }

  async deviceByUserCode(userCode, now) {
    const link = await this.#fresh(`usercode:${userCode}`, now);
    return link ? this.#fresh(`device:${link.device}`, now) : null;
  }

  async decideDevice(userCode, owner, approve, now) {
    const link = await this.#fresh(`usercode:${userCode}`, now);
    const device = link && (await this.#fresh(`device:${link.device}`, now));
    if (!device || device.status !== 'pending') return null;
    await this.ctx.storage.put(`device:${link.device}`, { ...device, status: approve ? 'approved' : 'denied', owner: approve ? owner : null });
    return device.agent_name;
  }

  // The agent collects its token once; the sign-in code is then gone. Polling
  // is capped (a code lasts ten minutes; one poll every few seconds is plenty).
  async collectDevice(hash, token, now) {
    const device = await this.#fresh(`device:${hash}`, now);
    if (!device) return { status: 'expired' };
    if (device.status === 'pending') {
      if ((device.polls ?? 0) >= 300) {
        await this.ctx.storage.delete([`device:${hash}`, `usercode:${device.user_code}`]);
        return { status: 'expired' };
      }
      await this.ctx.storage.put(`device:${hash}`, { ...device, polls: (device.polls ?? 0) + 1 });
      return { status: 'pending' };
    }
    await this.ctx.storage.delete([`device:${hash}`, `usercode:${device.user_code}`]);
    if (device.status === 'denied') return { status: 'denied' };
    await this.ctx.storage.put(`token:${token.hash}`, { ...token.record, owner: device.owner, label: device.agent_name });
    await this.#indexToken(device.owner, token.hash);
    return { status: 'approved', owner: device.owner };
  }

  // For a card that never reached the renderer: its slot is returned, and it
  // fails, or (a started draft) waits for its summary again, as drafted.
  async refund(id, error, now) {
    const card = await this.card(id);
    if (!card) return;
    const key = `used:${dayKey(card.created_at)}`;
    const used = (await this.ctx.storage.get(key)) ?? 0;
    const writes = { [key]: Math.max(0, used - 1) };
    // So does a guest's card for the day.
    const slot = card.guest_slot ? await this.#fresh(card.guest_slot, now) : null;
    if (slot) writes[card.guest_slot] = { ...slot, count: Math.max(0, slot.count - 1) };
    const waits = card.drafted_at && now - card.drafted_at < 86_400_000;
    const next = waits ? { ...card, status: 'waiting_summary', created_at: card.drafted_at, drafted_at: null } : { ...card, status: 'failed', error };
    writes[`card:${id}`] = { ...next, step: null, job: null, guest_slot: null, updated_at: now };
    await this.ctx.storage.put(writes);
  }

  async card(id) {
    return (await this.ctx.storage.get(`card:${id}`)) ?? null;
  }

  // Deletes a card for good, asked by its owner or co-owner (its sign-in,
  // `token`, checked again here): its record and its place in both owners'
  // lists, the matching pool and the follow-up list. (The worker removes its
  // files; requests that name it then find nothing.)
  async deleteCard(id, owner, token = null) {
    if (!(await this.#signedIn(token, Date.now()))) return { ok: false, code: 'signed_out' };
    const card = await this.card(id);
    if (!card || ![card.owner, card.co_owner].includes(owner)) return { ok: false, code: 'not_found' };
    const writes = {};
    for (const each of [card.owner, card.co_owner].filter(Boolean)) {
      const list = (await this.ctx.storage.get(`cards-of:${each}`)) ?? [];
      writes[`cards-of:${each}`] = list.filter((x) => x !== id);
    }
    for (const key of ['pool', 'follow-ups']) {
      const ids = (await this.ctx.storage.get(key)) ?? [];
      if (ids.includes(id)) writes[key] = ids.filter((x) => x !== id);
    }
    await this.ctx.storage.put(writes);
    await this.ctx.storage.delete(`card:${id}`);
    return { ok: true, card };
  }

  // The renderer proves which job it is with the token the worker gave it;
  // only the card's current job may write, and none once the card is done. A
  // re-render's uploads replace the live files, so from before the first one
  // until its "ready" the page may show a change the record does not have
  // (see pageBehind).
  async beginUpload(id, job, now) {
    const card = await this.card(id);
    if (!card?.job || card.job !== job) return false;
    if (card.rerender && !card.upload_unconfirmed) await this.ctx.storage.put(`card:${id}`, { ...card, upload_unconfirmed: true, updated_at: now });
    return true;
  }

  async addFile(id, job, file, now) {
    const card = await this.card(id);
    if (!card?.job || card.job !== job) return false;
    if (!card.files.includes(file)) await this.ctx.storage.put(`card:${id}`, { ...card, files: [...card.files, file], updated_at: now });
    return true;
  }

  async jobStatus(id, job, update, now) {
    const card = await this.card(id);
    // The job that finished the card may repeat its "ready" (a lost reply, say).
    if (card && !card.job && card.last_job === job && card.status === 'ready' && update.status === 'ready') return { ok: true };
    if (!card?.job || card.job !== job) return { ok: false, status: 403, code: 'forbidden', message: 'This job token cannot update that card.' };
    const concept = update.concept ? { concept: update.concept } : {};
    let next;
    if (update.status === 'queued') {
      next = {};
    } else if (update.status === 'rendering') {
      next = { status: 'rendering', step: update.step, ...concept };
    } else if (update.status === 'failed') {
      if (card.rerender) {
        const { followUp } = await this.#revert(card, update.error || 'Rendering failed.', now, update.unsent);
        return { ok: true, followUp };
      } else {
        next = { status: 'failed', step: null, error: update.error || 'Rendering failed.', job: null };
      }
    } else {
      const missing = update.files.filter((file) => !card.files.includes(file));
      if (!update.files.includes('index.html')) missing.push('index.html');
      if (missing.length) return { ok: false, status: 409, code: 'missing_files', message: `Not uploaded yet: ${[...new Set(missing)].join(', ')}.` };
      next = { ...card, status: 'ready', step: null, error: null, files: update.files, job: null, last_job: job, rerender: false, before: null, upload_unconfirmed: false, page_badge: update.page_badge ?? null, ...concept };
      // A proved badge reaching the page at last: the render that failed before
      // has gone through (unless it also undid a change, such as a sponsorship).
      if (!card.change_undone && card.badge && card.badge.source !== 'logs' && !sameBadge(card.badge, card.page_badge) && sameBadge(card.badge, next.page_badge)) next.last_error = null;
      if (card.sponsor?.unsettled) next.sponsor = { ...card.sponsor, unsettled: false };
      const { followUp } = await this.#putReady(next, now);
      return { ok: true, files: true, followUp };
    }
    await this.ctx.storage.put(`card:${id}`, { ...card, ...next, updated_at: now });
    return { ok: true };
  }

  // A re-render that failed or went quiet leaves the card as it was: ready,
  // with what the change replaced put back; a sponsorship it was adding is
  // undone and refunded. (Files it uploaded meanwhile are re-rendered away,
  // see pageBehind.) A render the renderer never received (`unsent`) gives
  // back the follow-up try it took, so an outage does not use them up.
  async #revert(card, error, now, unsent = false) {
    const undone = Boolean(card.sponsor?.unsettled || card.before);
    const tries = unsent ? Math.max(0, (card.follow_up_tries ?? 0) - 1) : card.follow_up_tries;
    const next = { ...card, ...card.before, before: null, status: 'ready', step: null, error: null, job: null, rerender: false, last_error: error, change_undone: Boolean(card.change_undone || undone), follow_up_tries: tries };
    if (card.sponsor?.unsettled) {
      await this.#refundSponsor(card);
      next.sponsor = null;
    }
    return this.#putReady(next, now);
  }

  // Saves a card that is ready again. If its page is behind its record, the
  // card asks for a follow-up render (queueFollowUp counts them: two in a row
  // at most, so a renderer that keeps failing is not asked forever). The
  // caller sends it at once if it can; otherwise the worker's scheduled sweep
  // sends it once it is due (dueFollowUps).
  async #putReady(card, now) {
    const behind = pageBehind(card);
    const tries = behind ? (card.follow_up_tries ?? 0) : 0;
    const followUp = behind && tries < 2;
    const next = { ...card, follow_up_tries: tries, follow_up_after: followUp ? now + followUpDelay(this.env) : null, updated_at: now };
    await this.ctx.storage.put(`card:${card.id}`, next);
    if (followUp) {
      const ids = (await this.ctx.storage.get('follow-ups')) ?? [];
      if (!ids.includes(card.id)) await this.ctx.storage.put('follow-ups', [...ids, card.id]);
    }
    return { card: next, followUp };
  }

  async #refundSponsor(card) {
    const { brand_id: brandId, price = 0, credits = 0 } = card.sponsor;
    const brand = await this.ctx.storage.get(`brand:${brandId}`);
    if (brand) await this.ctx.storage.put(`brand:${brandId}`, { ...brand, spent: Math.max(0, brand.spent - price), wins: Math.max(0, (brand.wins ?? 1) - 1) });
    // Back from whoever was credited (a co-owner may have run the auction).
    const account = card.sponsor.credited_to ?? card.owner;
    const owed = (await this.ctx.storage.get(`credits:${account}`)) ?? 0;
    await this.ctx.storage.put(`credits:${account}`, Math.max(0, owed - credits));
  }

  // Fails a card whose renderer went quiet (re-checked here, atomically).
  async markStale(id, staleMs, error, now) {
    const card = await this.card(id);
    if (!card || !['queued', 'rendering', 'waiting_summary'].includes(card.status)) return { card };
    // A draft waits a day for its summary (its upload link keeps it 24 hours).
    const waitingTooLong = card.status === 'waiting_summary' && now - card.created_at > 86_400_000;
    const silent = card.status !== 'waiting_summary' && now - card.updated_at > staleMs;
    if (!waitingTooLong && !silent) return { card };
    if (card.rerender && silent) return this.#revert(card, error, now);
    const next = { ...card, status: 'failed', step: null, error: waitingTooLong ? 'The summary for this card never arrived.' : error, job: null, updated_at: now };
    await this.ctx.storage.put(`card:${id}`, next);
    return { card: next, followUp: false };
  }

  // An admin retry gives the card a new job token, so only the new render can report.
  async restart(id, job, now) {
    const card = await this.card(id);
    if (!card) return null;
    // Retrying a ready card re-renders it: media is reused and a failure leaves it ready.
    const next = { ...card, ...FRESH_CHANGE, status: 'queued', step: null, error: null, job, rerender: card.rerender || card.status === 'ready', updated_at: now };
    await this.ctx.storage.put(`card:${id}`, next);
    return next;
  }

  async alarm() {
    const now = Date.now();
    for (const prefix of EXPIRING) {
      let startAfter;
      do {
        const rows = await this.ctx.storage.list({ prefix, limit: 512, ...(startAfter ? { startAfter } : {}) });
        const expired = [...rows].filter(([, value]) => value?.expires_at <= now).map(([key]) => key);
        // The storage API deletes at most 128 keys per call.
        for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128));
        startAfter = rows.size === 512 ? [...rows.keys()].at(-1) : null;
      } while (startAfter);
    }
    await this.ctx.storage.setAlarm(now + 3_600_000);
  }

  async #fresh(key, now) {
    const value = await this.ctx.storage.get(key);
    if (value?.expires_at !== undefined && value.expires_at <= now) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return value ?? null;
  }

  async #putExpiring(key, value) {
    await this.ctx.storage.put(key, value);
    await this.#ensureAlarm();
  }

  async #ensureAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
}

// A ready card's page may not show what its record says: a re-render
// uploaded files but never confirmed them (it failed or went quiet), or a
// proved badge arrived that the page does not show yet.
function pageBehind(card) {
  return Boolean(card.upload_unconfirmed || (card.badge && card.badge.source !== 'logs' && !sameBadge(card.badge, card.page_badge)));
}

// Two badges say the same thing (null for none).
function sameBadge(a, b) {
  return (a?.source ?? null) === (b?.source ?? null) && (a?.value ?? null) === (b?.value ?? null) && (a?.label ?? null) === (b?.label ?? null);
}

// How long a follow-up render the worker could not send waits for the
// scheduled sweep (FOLLOW_UP_DELAY_MS, default two minutes).
function followUpDelay(env) {
  const ms = Number(env?.FOLLOW_UP_DELAY_MS);
  return Number.isInteger(ms) && ms >= 0 ? ms : 120_000;
}

// Days run on UTC.
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function defaultCap(env) {
  const n = Number(env.CARDS_PER_DAY);
  return Number.isInteger(n) && n >= 0 ? n : 300;
}
