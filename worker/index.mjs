// ZKAds worker: the public API that agents call, the card pages and media,
// and the global daily cap. Cards are rendered by the enclave service, which
// reports back through the /internal routes with a per-card job token.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { buildClaudePrompt, CONCEPT_SCHEMA, displayName, identifierIn, parseConcept, validateConcept } from '../lib/concept.mjs';
import { cleanBrand, cleanSponsor } from '../lib/brands.mjs';
import { buildSummaryPrompt } from '../lib/together.mjs';
import { badgeFromStats, cleanBadge, cleanStats, formatCount } from '../lib/usage.mjs';
import SKILL from '../skill/SKILL.md';
import { Registry } from './registry.mjs';

export { Registry };

const ID = '([a-z2-7]{20})';
const CARD_FILES = { 'index.html': 'text/html; charset=utf-8', 'poster.jpg': 'image/jpeg', 'ad.mp4': 'video/mp4', 'story.mp4': 'video/mp4', 'attestation.json': 'application/json; charset=utf-8' };
// The landing page's example also has its bare orbit, for the 360° preview.
const EXAMPLE_FILES = { 'index.html': CARD_FILES['index.html'], 'poster.jpg': 'image/jpeg', 'ad.mp4': 'video/mp4', 'story.mp4': 'video/mp4', 'orbit.mp4': 'video/mp4' };
const MAX_FILE_BYTES = 90 * 1024 * 1024;
const STEPS = ['concept', 'image', 'orbit', 'music', 'page'];
const MATCHING_HOURS = 72;
const DAY = 86_400_000;
const SESSION_DAYS = 30;
const AGENT_DAYS = 30;
const DEVICE_SECONDS = 600;
// A guest (from an event code) makes at most this many cards a day, so one
// leaked sign-in cannot use up everyone's daily cap.
const GUEST_CARDS = 5;
// Invite codes avoid look-alike characters; sign-in codes use consonants only,
// so they never spell words.
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
// Card pages are rendered from concept text, so they run as a sandboxed,
// opaque origin (no cookies, storage or same-origin requests) and may load
// only their own media, even if some text ever slipped past the escaping.
// Sources name the origin explicitly: 'self' is ambiguous for an opaque origin.
function pageCsp(origin) {
  // Popups (Share on X) open outside the sandbox, as ordinary pages.
  return `sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${origin} data:; media-src ${origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}
// A card with no progress report for this long is marked failed (and can be retried).
const STALE_MS = 45 * 60_000;

const ROUTES = [
  ['GET', /^\/$/, home],
  ['GET', /^\/skill\.md$/i, skill],
  ['GET', /^\/v1\/prompt$/, prompt],
  ['GET', /^\/v1\/schema$/, () => json(CONCEPT_SCHEMA)],
  ['POST', /^\/v1\/auth\/register\/options$/, registerOptions],
  ['POST', /^\/v1\/auth\/register\/verify$/, registerVerify],
  ['POST', /^\/v1\/auth\/login\/options$/, loginOptions],
  ['POST', /^\/v1\/auth\/login\/verify$/, loginVerify],
  ['POST', /^\/v1\/auth\/claim\/options$/, claimOptions],
  ['POST', /^\/v1\/auth\/claim\/verify$/, claimVerify],
  ['POST', /^\/v1\/auth\/claim\/merge$/, claimMerge],
  ['POST', /^\/v1\/auth\/logout$/, logout],
  ['GET', /^\/v1\/me$/, me],
  ['POST', /^\/v1\/agent\/guest$/, startGuest],
  ['POST', /^\/v1\/agent\/device$/, deviceStart],
  ['POST', /^\/v1\/agent\/token$/, deviceToken],
  ['GET', /^\/v1\/agent\/device\/([A-Z]{4}-[A-Z]{4})$/, deviceInfo],
  ['POST', /^\/v1\/agent\/approve$/, deviceApprove],
  ['POST', /^\/v1\/agent\/revoke$/, revokeAgent],
  ['POST', /^\/v1\/cards$/, createCard],
  ['POST', /^\/v1\/cards\/from-summary$/, cardFromSummary],
  ['POST', new RegExp(`^/v1/cards/${ID}/start$`), startFromSummary],
  ['POST', new RegExp(`^/v1/cards/${ID}/upload$`), draftUpload],
  ['GET', /^\/v1\/summary-prompt$/, () => text(buildSummaryPrompt(), 'text/markdown; charset=utf-8')],
  ['POST', new RegExp(`^/v1/cards/${ID}/matching$`), setMatching],
  ['GET', new RegExp(`^/v1/cards/${ID}/partners$`), partners],
  ['POST', new RegExp(`^/v1/cards/${ID}/invite$`), inviteToFuse],
  ['GET', /^\/v1\/fusion-invites\/([A-Za-z0-9-]{8,16})$/, fusionInviteInfo],
  ['POST', /^\/v1\/fusion-invites\/([A-Za-z0-9-]{8,16})\/accept$/, acceptFusionInvite],
  ['POST', /^\/v1\/fusions$/, requestFusion],
  ['GET', /^\/v1\/fusions$/, listFusions],
  ['POST', new RegExp(`^/v1/fusions/${ID}/(accept|decline|start)$`), decideFusion],
  ['POST', new RegExp(`^/v1/fusions/${ID}/upload$`), fusionUpload],
  ['POST', new RegExp(`^/v1/cards/${ID}/catalogue/([01])$`), catalogueCard],
  ['POST', new RegExp(`^/v1/cards/${ID}/delete$`), deleteCard],
  ['POST', new RegExp(`^/v1/cards/${ID}/usage$`), postUsage],
  ['POST', new RegExp(`^/v1/cards/${ID}/proofs/codex$`), startCodexProof],
  ['GET', /^\/v1\/proofs\/([a-z2-7]{20})$/, proofStatus],
  ['POST', /^\/internal\/proofs\/([a-z2-7]{20})$/, finishProof],
  ['GET', /^\/v1\/brands$/, listBrands],
  ['POST', /^\/v1\/brands\/bids$/, bidBrand],
  ['POST', new RegExp(`^/v1/cards/${ID}/sponsor$`), sponsorCard],
  ['GET', /^\/v1\/admin\/brands$/, adminBrands],
  ['POST', /^\/v1\/admin\/brands\/([a-z0-9-]{1,40})\/(approve|reject)$/, moderateBrand],
  ['GET', new RegExp(`^/v1/cards/${ID}$`), cardStatus],
  ['GET', new RegExp(`^/c/${ID}$`), (c, id) => Response.redirect(`${c.base}/c/${id}/`, 301)],
  ['GET', new RegExp(`^/c/${ID}/([a-z0-9.]*)$`), cardFile],
  ['GET', /^\/example$/, (c) => Response.redirect(`${c.url.origin}/example/`, 301)],
  ['GET', /^\/example\/([a-z0-9.]*)$/, exampleFile],
  ['PUT', new RegExp(`^/internal/cards/${ID}/files/([a-z0-9.]+)$`), uploadFile],
  ['POST', new RegExp(`^/internal/cards/${ID}/status$`), jobStatus],
  ['GET', /^\/v1\/admin\/cap$/, getCap],
  ['POST', /^\/v1\/admin\/cap$/, setCap],
  ['POST', /^\/v1\/admin\/tokens$/, issueToken],
  ['POST', /^\/v1\/admin\/invites$/, createInvites],
  ['POST', /^\/v1\/admin\/revoke$/, adminRevoke],
  ['POST', new RegExp(`^/v1/admin/cards/${ID}/retry$`), retryCard],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      response = await route(request, env, url);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      response = error instanceof ApiError ? problem(error.status, error.code, error.message) : problem(500, 'internal', 'Something went wrong.');
    }
    return url.pathname.startsWith('/v1/') ? withCors(response) : response;
  },

  // Every five minutes (see wrangler.jsonc): follow-up renders that could not
  // reach the renderer when they were first due.
  async scheduled(controller, env) {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    // (Without either, as in local development, wrangler dev's address.)
    const url = new URL(env.PUBLIC_URL || env.APP_ORIGIN || 'http://localhost:8787');
    const c = { env, url, registry, base: url.origin };
    for (const id of await registry.dueFollowUps(Date.now())) await followUpRender(c, id);
  },
};

async function route(request, env, url) {
  // Agents authenticate with bearer tokens, never cookies, so any site may call the API.
  if (request.method === 'OPTIONS' && url.pathname.startsWith('/v1/')) return new Response(null, { status: 204 });
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  for (const [verb, pattern, handler] of ROUTES) {
    const match = verb === method && url.pathname.match(pattern);
    if (match) {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
      const base = (env.PUBLIC_URL || url.origin).replace(/\/+$/, '');
      return handler({ request, env, url, registry, base }, ...match.slice(1));
    }
  }
  throw new ApiError(404, 'not_found', 'No such endpoint.');
}

function home(c) {
  return text(`ZKAds: an ad for an audience of one.\n\nAgents: read ${c.base}/skill.md\n`);
}

function skill(c) {
  return text(SKILL.replaceAll('{{API}}', c.base).replaceAll('{{APP}}', appOrigin(c)), 'text/markdown; charset=utf-8');
}

// Only the era can be chosen here. A name or artist in a link would land in
// the brief agents follow, so the agent supplies those itself.
function prompt(c) {
  const era = c.url.searchParams.get('era') ?? 'any';
  if (!['scifi', 'historical', 'any'].includes(era)) throw new ApiError(400, 'bad_request', 'era must be scifi, historical or any.');
  return text(buildClaudePrompt({ era }), 'text/markdown; charset=utf-8');
}

// Passkey sign-up: an invite code unlocks one new member.
async function registerOptions(c) {
  await rateLimit(c, 'invite', 60);
  const { invite } = (await readJson(c.request, 1024)) ?? {};
  const code = inviteCode(invite);
  const inviteHash = code && (await sha256(code));
  if (!inviteHash || !(await c.registry.inviteUsable(inviteHash))) throw new ApiError(403, 'bad_invite', 'That invite code is not valid or has been used up.');
  const user = newUser();
  const options = await passkeyOptions(c, user);
  const ceremony = secretToken();
  await c.registry.saveCeremony(ceremony, { kind: 'register', challenge: options.challenge, invite: inviteHash, user, webauthn_user_id: options.user.id, expires_at: Date.now() + 300_000 });
  return json({ ceremony, options });
}

async function registerVerify(c) {
  const { ceremony, response } = (await readJson(c.request, 64 * 1024)) ?? {};
  const pending = await takeCeremony(c, ceremony, 'register');
  const credential = await newPasskey(c, pending, response);
  const session = await newSession(pending.user.id);
  const result = await c.registry.register({ invite: pending.invite, user: pending.user, credential, session }, Date.now());
  if (!result.ok) throw new ApiError(409, result.code, result.message);
  return json({ session: session.token, user: pending.user }, 201);
}

// An event code lets an assistant start a guest account for its person in
// one step, with no passkey and no approval: it can make cards at once. The
// person saves the account later with a passkey (the claim link), which
// fusions need, and its cards stay theirs.
async function startGuest(c) {
  await rateLimit(c, 'guest', 60);
  const body = (await readJson(c.request, 1024)) ?? {};
  const code = inviteCode(body.code);
  if (!code) throw new ApiError(403, 'bad_code', 'That event code is not valid, has expired or has been used up.');
  // Worked out first, so a misconfigured site stores nothing.
  const app = appOrigin(c);
  const user = newUser();
  const token = `zka_${secretToken()}`;
  const claim = secretToken();
  const now = Date.now();
  const record = { owner: `user:${user.id}`, label: displayName(body.agent_name) || 'An assistant', scope: 'agent', created_at: now, expires_at: now + AGENT_DAYS * DAY };
  const made = await c.registry.createGuest({ invite: await sha256(code), user, token: { hash: await sha256(token), record }, claim: await sha256(claim) }, now);
  if (!made.ok) throw new ApiError(403, made.code, made.message);
  // The guest lasts as long as the event code. The claim code rides in the
  // link's fragment, which browsers never send to a server.
  return json({ token, expires_at: new Date(made.expires_at).toISOString(), account: user.handle, claim_url: `${app}/claim#${claim}` }, 201);
}

// Saving a guest account: its claim code lets the person add a passkey to
// that same account, once.
async function claimOptions(c) {
  await rateLimit(c, 'claim', 60);
  const { claim } = (await readJson(c.request, 1024)) ?? {};
  const hash = typeof claim === 'string' && /^[\w-]{43}$/.test(claim) ? await sha256(claim) : null;
  const user = hash && (await c.registry.claimable(hash, Date.now()));
  if (!user) throw new ApiError(404, 'bad_claim', 'This account has already been saved (if that was you just now, sign in with your passkey), or the link has expired.');
  const options = await passkeyOptions(c, user);
  const ceremony = secretToken();
  await c.registry.saveCeremony(ceremony, { kind: 'claim', challenge: options.challenge, claim: hash, user: { id: user.id, handle: user.handle }, webauthn_user_id: options.user.id, expires_at: Date.now() + 300_000 });
  return json({ ceremony, options });
}

async function claimVerify(c) {
  const { ceremony, response } = (await readJson(c.request, 64 * 1024)) ?? {};
  const pending = await takeCeremony(c, ceremony, 'claim');
  const credential = await newPasskey(c, pending, response);
  const session = await newSession(pending.user.id);
  const result = await c.registry.claimGuest({ claim: pending.claim, credential, session }, Date.now());
  if (!result.ok) throw new ApiError(409, result.code, result.message);
  // Summaries sealed before saving go, and upload links handed out before now
  // stop working. If the enclave cannot be reached, its cards are already out
  // of matching, and the summaries expire within 72 hours.
  if (result.forget.length) await dispatch(c.env, { keys: result.forget, at: Date.now() }, '/jobs/forget').catch((error) => console.error(`forget on save: ${error.message}`));
  return json({ session: session.token, user: pending.user }, 201);
}

// A member signed in with their passkey takes a guest account's cards into
// their own account instead of saving it as a second one: they hold its
// claim code (its save link, or the guest account in their browser).
async function claimMerge(c) {
  await rateLimit(c, 'claim', 60);
  // (The body first, so a sign-in checked now cannot be used after it ends.)
  const { claim } = (await readJson(c.request, 1024)) ?? {};
  const member = await requireSession(c);
  const hash = typeof claim === 'string' && /^[\w-]{43}$/.test(claim) ? await sha256(claim) : null;
  const result = hash ? await c.registry.mergeGuest({ claim: hash, owner: member.owner }, Date.now()) : { ok: false, code: 'bad_claim', message: 'This guest account has already been saved or moved, or the link has expired.' };
  if (!result.ok) throw new ApiError(result.code === 'bad_claim' ? 404 : 409, result.code, result.message);
  if (result.forget.length) await dispatch(c.env, { keys: result.forget, at: Date.now() }, '/jobs/forget').catch((error) => console.error(`forget on merge: ${error.message}`));
  return json({ moved: result.moved });
}

function newUser() {
  const id = secretToken().slice(0, 16);
  return { id, handle: `zkads-${id.slice(0, 6).toLowerCase()}` };
}

function passkeyOptions(c, user) {
  return generateRegistrationOptions({
    rpName: 'ZKAds',
    rpID: rpId(c),
    userID: new TextEncoder().encode(user.id),
    userName: user.handle,
    userDisplayName: 'ZKAds member',
    attestationType: 'none',
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

// The passkey a registration ceremony made, checked, as it is stored.
async function newPasskey(c, pending, response) {
  try {
    const result = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: appOrigin(c), expectedRPID: rpId(c), requireUserVerification: true });
    if (!result.verified || !result.registrationInfo) throw new Error('unverified');
    const { credential } = result.registrationInfo;
    return { id: credential.id, public_key: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [], webauthn_user_id: pending.webauthn_user_id };
  } catch {
    throw new ApiError(401, 'passkey_failed', 'The passkey could not be verified. Try again.');
  }
}

async function loginOptions(c) {
  await rateLimit(c, 'login', 120);
  const options = await generateAuthenticationOptions({ rpID: rpId(c), userVerification: 'required' });
  const ceremony = secretToken();
  await c.registry.saveCeremony(ceremony, { kind: 'login', challenge: options.challenge, expires_at: Date.now() + 300_000 });
  return json({ ceremony, options });
}

async function loginVerify(c) {
  const { ceremony, response } = (await readJson(c.request, 64 * 1024)) ?? {};
  const pending = await takeCeremony(c, ceremony, 'login');
  const failed = new ApiError(401, 'passkey_failed', 'That passkey could not be verified. If you have not joined yet, use an invite code.');
  const stored = typeof response?.id === 'string' && response.id.length < 1024 ? await c.registry.credential(response.id) : null;
  if (!stored) throw failed;
  // The passkey's user handle, when sent, must be the one it was made with.
  if (response.response?.userHandle && response.response.userHandle !== stored.webauthn_user_id) throw failed;
  let counter;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: appOrigin(c),
      expectedRPID: rpId(c),
      credential: { id: stored.id, publicKey: stored.public_key, counter: stored.counter, transports: stored.transports },
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error('unverified');
    counter = result.authenticationInfo.newCounter;
  } catch {
    throw failed;
  }
  const session = await newSession(stored.user_id);
  const user = await c.registry.login({ credentialId: stored.id, counter, session });
  if (!user) throw failed;
  return json({ session: session.token, user: { id: user.id, handle: user.handle } });
}

async function logout(c) {
  const token = bearer(c.request);
  if (token) await c.registry.deleteToken(await sha256(token));
  return json({ ok: true });
}

// The member's own cards; agents may read them too. A passkey session also
// sees the assistants it has approved, so it can revoke them.
async function me(c) {
  const member = await requireMember(c);
  const user = member.owner.startsWith('user:') ? await c.registry.user(member.owner.slice(5)) : null;
  const cards = await c.registry.cardsOf(member.owner);
  const agents = member.scope === 'session' ? (await c.registry.tokensOf(member.owner, Date.now())).filter((token) => token.scope === 'agent') : undefined;
  return json({
    // A guest account (from an event code) has no passkey until it is saved,
    // which it must be before its sign-in ends with the code.
    user: user && { id: user.id, handle: user.handle, guest: Boolean(user.guest), ...(member.event ? { save_by: new Date(member.expires_at).toISOString() } : {}) },
    via: member.scope,
    cards: cards.map((card) => publicCard(card, c.base)),
    credits: await c.registry.credits(member.owner),
    agents: agents?.map((agent) => ({ ...agent, created_at: new Date(agent.created_at).toISOString(), expires_at: new Date(agent.expires_at).toISOString() })),
  });
}

async function revokeAgent(c) {
  const { id } = (await readJson(c.request, 1024)) ?? {};
  const member = await requireSession(c);
  if (typeof id !== 'string' || !/^[0-9a-f]{12,64}$/.test(id)) throw new ApiError(400, 'bad_request', 'id must be an assistant id from /v1/me.');
  if (!(await c.registry.revokeToken(member.owner, id))) throw new ApiError(404, 'not_found', 'No such assistant.');
  return json({ ok: true });
}

// Revokes one token (by its value), every token an owner holds, or an invite
// or event code (the event code's unsaved guests lose their sign-ins; other
// accounts it made stay).
async function adminRevoke(c) {
  await requireAdmin(c);
  const body = (await readJson(c.request, 1024)) ?? {};
  if (typeof body.token === 'string' && body.token.length < 200) {
    await c.registry.deleteToken(await sha256(body.token));
    return json({ ok: true, revoked: 1 });
  }
  if (typeof body.owner === 'string' && /^(user|invitee):/.test(body.owner)) {
    const { revoked, forget } = await c.registry.revokeAll(body.owner);
    if (forget.length) await dispatch(c.env, { keys: forget, at: Date.now() }, '/jobs/forget').catch((error) => console.error(`forget on revoke: ${error.message}`));
    return json({ ok: true, revoked });
  }
  const code = inviteCode(body.invite);
  if (code) {
    const { revoked, forget } = await c.registry.revokeInvite(await sha256(code));
    if (forget.length) await dispatch(c.env, { keys: forget, at: Date.now() }, '/jobs/forget').catch((error) => console.error(`forget on revoke: ${error.message}`));
    return json({ ok: true, revoked: revoked ? 1 : 0 });
  }
  throw new ApiError(400, 'bad_request', 'Send token (its value), owner (user:… or invitee:…) or invite (a ZK-… code).');
}

// Agent sign-in, step 1: the agent asks for a code to show its person.
async function deviceStart(c) {
  await rateLimit(c, 'device', 60);
  const body = (await readJson(c.request, 1024)) ?? {};
  const agentName = displayName(body.agent_name) || 'An assistant';
  // Worked out first, so a misconfigured site stores nothing.
  const app = appOrigin(c);
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = secretToken();
    const userCode = randomCode(USER_CODE_ALPHABET, 8).replace(/^(.{4})/, '$1-');
    const started = await c.registry.startDevice({ hash: await sha256(deviceCode), userCode, agentName, expiresAt: Date.now() + DEVICE_SECONDS * 1000 });
    if (started) {
      return json({ device_code: deviceCode, user_code: userCode, verify_url: `${app}/approve?code=${userCode}`, interval: 5, expires_in: DEVICE_SECONDS }, 201);
    }
  }
  throw new ApiError(503, 'busy', 'Could not make a sign-in code. Try again.');
}

// Step 2: the agent polls until its person approves (or declines).
async function deviceToken(c) {
  await rateLimit(c, 'device-poll', 600);
  const { device_code: deviceCode } = (await readJson(c.request, 1024)) ?? {};
  if (typeof deviceCode !== 'string' || deviceCode.length > 100) throw new ApiError(400, 'bad_request', 'device_code is required.');
  const token = `zka_${secretToken()}`;
  const now = Date.now();
  const record = { scope: 'agent', created_at: now, expires_at: now + AGENT_DAYS * DAY };
  const { status, owner } = await c.registry.collectDevice(await sha256(deviceCode), { hash: await sha256(token), record }, now);
  if (status === 'pending') return json({ status: 'pending', interval: 5 }, 202);
  if (status === 'denied') throw new ApiError(403, 'denied', 'Your person declined this sign-in.');
  if (status === 'expired') throw new ApiError(404, 'expired', 'This sign-in code expired or was already used. Start again.');
  // Which account approved, so the person can tell if someone else did.
  const user = owner?.startsWith('user:') ? await c.registry.user(owner.slice(5)) : null;
  return json({ status: 'approved', token, expires_at: new Date(record.expires_at).toISOString(), approved_by: user?.handle ?? null });
}

// For the approval page: which agent is asking.
async function deviceInfo(c, userCode) {
  const member = await requireSession(c);
  await rateLimit(c, 'device-look', 60);
  const device = await c.registry.deviceByUserCode(userCode, Date.now());
  if (!device || device.status !== 'pending') throw new ApiError(404, 'expired', 'That code expired or was already used. If your assistant showed it to you just now, someone else may have approved it first: tell your assistant to sign out and start again.');
  const user = await c.registry.user(member.owner.slice(5));
  return json({ agent_name: device.agent_name, asked_at: new Date(device.created_at ?? Date.now()).toISOString(), expires_at: new Date(device.expires_at).toISOString(), account: user?.handle ?? null });
}

async function deviceApprove(c) {
  const body = (await readJson(c.request, 1024)) ?? {};
  const member = await requireSession(c);
  await rateLimit(c, 'device-look', 60);
  if (typeof body.approve !== 'boolean') throw new ApiError(400, 'bad_request', 'approve must be true or false.');
  const userCode = typeof body.user_code === 'string' ? body.user_code.toUpperCase().replace(/[^A-Z]/g, '').replace(/^(.{4})/, '$1-') : '';
  const agent = await c.registry.decideDevice(userCode, member.owner, body.approve, Date.now());
  if (!agent) throw new ApiError(404, 'expired', 'That code expired or was already used. If your assistant showed it to you just now, someone else may have approved it first: tell your assistant to sign out and start again.');
  return json({ ok: true, agent_name: agent, approved: body.approve });
}

async function createCard(c) {
  // A text body is the assistant's whole reply; JSON is {concept, name} or a bare concept.
  const plain = /^text\/(plain|markdown)\b/i.test(c.request.headers.get('content-type') ?? '');
  const body = plain ? await readText(c.request, 128 * 1024) : await readJson(c.request, 128 * 1024);
  const agent = await requireMember(c);
  const concept = conceptFrom(body);
  // Worked out before a slot is taken: without APP_ORIGIN this refuses (500), and nothing is spent.
  const site = appOrigin(c);
  const now = Date.now();
  const token = secretToken();
  const card = {
    id: cardIdValue(),
    owner: agent.owner,
    name: cardName(body?.name),
    concept,
    status: 'queued',
    step: null,
    files: [],
    error: null,
    job: await sha256(token),
    created_at: now,
    updated_at: now,
  };
  const reserved = await c.registry.createCard(card, now, agent.event ? GUEST_CARDS : 0, agent.event ? agent.hash : null);
  if (reserved.code === 'signed_out') throw signedOut();
  if (reserved.code === 'guest_limit') throw guestLimit();
  if (!reserved.ok) throw new ApiError(429, 'daily_cap', `ZKAds has made all ${reserved.cap} of today's cards. The limit resets at midnight UTC.`);
  await dispatchOrRefund(c, card, { card_id: card.id, token, concept, name: card.name, site });
  return json(publicCard(card, c.base), 202);
}

// A guest's sign-in that ended while its request was under way (checked
// again where the request stores anything).
function signedOut() {
  return new ApiError(401, 'unauthorized', 'This token is unknown or has expired.');
}

// (Counted with the cap slot, so a card that never reaches the renderer is
// given back too.)
function guestLimit() {
  return new ApiError(429, 'rate_limited', `A guest account makes at most ${GUEST_CARDS} cards a day. Save it with a passkey to make more, or try again tomorrow.`);
}

// A refused or unreachable renderer never got the job, so the card fails and
// its slot is returned. A timeout is different: the renderer may be working
// (and paying), so the card stays queued and counted; if it never reports,
// it goes stale and fails.
async function dispatchOrRefund(c, card, job) {
  try {
    await dispatch(c.env, job);
  } catch (error) {
    if (error.name === 'TimeoutError') {
      console.error(`dispatch ${short(card.id)}: no answer in time; leaving it queued`);
      return;
    }
    console.error(`dispatch ${short(card.id)}: ${error.message}`);
    await c.registry.refund(card.id, 'The renderer could not be reached, so this card was not made. It did not count toward the daily limit.', Date.now());
    throw new ApiError(503, 'renderer_unavailable', 'The renderer is unavailable right now. Try again in a minute.');
  }
}

// Reads a card, failing it first if its renderer went quiet.
async function readCard(c, id) {
  const card = await c.registry.card(id);
  if (card && ['queued', 'rendering', 'waiting_summary'].includes(card.status) && Date.now() - (card.status === 'waiting_summary' ? card.created_at : card.updated_at) > (card.status === 'waiting_summary' ? DAY : STALE_MS)) {
    const { card: next, followUp } = await c.registry.markStale(id, STALE_MS, 'The renderer stopped reporting. ZKAds can retry this card.', Date.now());
    if (followUp) await followUpRender(c, id);
    return next;
  }
  return card;
}

function short(id) {
  return id.slice(0, 6);
}

// The fallback for assistants that cannot write the concept themselves: the
// card waits (uncounted) while the assistant seals a summary in the enclave,
// then POST /v1/cards/:id/start has the enclave write the concept from it.
async function cardFromSummary(c) {
  const body = (await readJson(c.request, 1024)) ?? {};
  const member = await requireMember(c);
  // Worked out first, so nothing is stored while the enclave cannot be reached.
  enclavePublic(c);
  const name = cardName(body.name);
  await limit(c, `drafts:${member.owner}`, 20, DAY, 'You have started a lot of cards from summaries today. Try again tomorrow.');
  const era = ['scifi', 'historical'].includes(body.era) ? body.era : 'any';
  const now = Date.now();
  const id = cardIdValue();
  const card = {
    id,
    owner: member.owner,
    name,
    concept: null,
    write: { kind: 'summary', summary_key: `draft:${id}`, owner: member.owner, era },
    status: 'waiting_summary',
    step: null,
    files: [],
    error: null,
    job: null,
    created_at: now,
    updated_at: now,
  };
  // At most five waiting at once, counted and created in one step.
  const made = await c.registry.createDraft(card, 5, now, member.event ? member.hash : null);
  if (made.code === 'signed_out') throw signedOut();
  if (!made.ok) throw new ApiError(409, 'drafts_waiting', 'You have five cards waiting for a summary. Start one, or wait for one to expire (a draft waits one day).');
  return json({ ...publicCard(card, c.base), upload: await summaryUpload(c, `draft:${id}`, member.owner, 24), start_url: `${c.base}/v1/cards/${id}/start`, summary_prompt_url: `${c.base}/v1/summary-prompt` }, 201);
}

// A fresh upload link for a card still waiting for its summary.
async function draftUpload(c, id) {
  const member = await requireMember(c);
  const waiting = await readCard(c, id);
  if (!waiting || ![waiting.owner, waiting.co_owner].includes(member.owner)) throw new ApiError(404, 'not_found', 'No such card of yours.');
  if (waiting.status !== 'waiting_summary') throw new ApiError(409, 'not_waiting', 'This card is not waiting for a summary (a draft waits one day).');
  enclavePublic(c);
  await limit(c, `draft-upload:${id}`, 10, DAY, 'That is a lot of upload links for one card. Try again tomorrow.');
  return json({ upload: await summaryUpload(c, waiting.write.summary_key, member.owner, 24), start_url: `${c.base}/v1/cards/${id}/start` });
}

async function startFromSummary(c, id) {
  const member = await requireMember(c);
  const waiting = await readCard(c, id);
  if (!waiting || ![waiting.owner, waiting.co_owner].includes(member.owner)) throw new ApiError(404, 'not_found', 'No such card of yours.');
  if (waiting.status !== 'waiting_summary') throw new ApiError(409, 'not_waiting', 'This card has already started, or waited longer than a day.');
  if (!(await sealed(c, [waiting.write.summary_key])).has(waiting.write.summary_key)) throw new ApiError(409, 'no_summary', 'Upload the summary to the enclave first (the upload link from creating the card).');
  const site = appOrigin(c);
  const token = secretToken();
  const started = await c.registry.startDraft(id, member.owner, await sha256(token), Date.now(), member.event ? GUEST_CARDS : 0, member.event ? member.hash : null);
  if (started.code === 'signed_out') throw signedOut();
  if (started.code === 'guest_limit') throw guestLimit();
  if (started.code === 'stale_draft') throw new ApiError(409, 'stale_draft', 'This draft is from before the account was saved, so it cannot be started. Make a new one.');
  if (started.code === 'daily_cap') throw new ApiError(429, 'daily_cap', `ZKAds has made all ${started.cap} of today's cards. The limit resets at midnight UTC.`);
  if (!started.ok) throw new ApiError(409, 'not_waiting', 'This card has already started.');
  await dispatchOrRefund(c, started.card, { card_id: id, token, write: started.card.write, name: started.card.name, site });
  return json(publicCard(started.card, c.base), 202);
}

// "Make this one" on a card's catalogue page, asked by the card's owner (or
// co-owner): the enclave writes a card from that item (public card text
// only, so no history is read), for the card's own account, so a guest's
// card comes along when the account is saved. Each item is made once, and
// asking again returns that card (unless it failed).
async function catalogueCard(c, id, item) {
  const member = await requireMember(c);
  const parent = await ownedCard(c, id, member);
  const site = appOrigin(c);
  const n = Number(item);
  // A card from an earlier ask that went quiet counts as failed, so it can be made again.
  if (parent.made?.[n]) await readCard(c, parent.made[n]);
  const token = secretToken();
  const now = Date.now();
  const base = { id: cardIdValue(), name: parent.name ?? null, parents: [id], concept: null, status: 'queued', step: null, files: [], error: null, job: await sha256(token), created_at: now, updated_at: now };
  const made = await c.registry.catalogueCard(id, n, base, now, member.event ? GUEST_CARDS : 0, member.event ? member.hash : null);
  if (made.existing) return json(publicCard(made.card, c.base));
  if (made.code === 'signed_out') throw signedOut();
  if (made.code === 'guest_limit') throw guestLimit();
  if (made.code === 'daily_cap') throw new ApiError(429, 'daily_cap', `ZKAds has made all ${made.cap} of today's cards. The limit resets at midnight UTC.`);
  if (made.code === 'not_ready') throw new ApiError(409, 'not_ready', 'Make one once the card is ready.');
  if (!made.ok) throw new ApiError(404, 'not_found', 'This card has no such catalogue item.');
  await dispatchOrRefund(c, made.card, { card_id: made.card.id, token, write: made.card.write, name: made.card.name, site });
  return json(publicCard(made.card, c.base), 202);
}

// Deletes one of the member's cards for good (either owner of a fused card
// may): its page and media, so its link stops working, its record, and what
// the enclave keeps for it (its media and any sealed summary). An
// unreachable enclave leaves its copy to expire on its own (a week at most).
async function deleteCard(c, id) {
  const member = await requireMember(c);
  const card = await c.registry.card(id);
  if (!card || ![card.owner, card.co_owner].includes(member.owner)) throw new ApiError(404, 'not_found', 'No such card of yours.');
  // The files go first, so a failure here leaves a card to delete again; and
  // again after the record, for an upload that landed in between (a later
  // one removes itself, see uploadFile).
  const files = Object.keys(CARD_FILES).map((file) => `cards/${id}/${file}`);
  await c.env.MEDIA.delete(files);
  const deleted = await c.registry.deleteCard(id, member.owner, member.event ? member.hash : null);
  if (deleted.code === 'signed_out') throw signedOut();
  if (!deleted.ok) throw new ApiError(404, 'not_found', 'No such card of yours.');
  // The card is gone now, so the rest is tried and logged, never fatal: the
  // enclave always hears of it.
  const log = (step) => (error) => console.error(`delete ${short(id)} (${step}): ${error.message}`);
  await c.env.MEDIA.delete(files).catch(log('files'));
  const keys = await ownFusionKeys(c, card).catch((error) => (log('fusion')(error), []));
  await dispatch(c.env, { card_id: id, keys, at: Date.now() }, '/jobs/drop').catch(log('drop'));
  return json({ ok: true, deleted: id });
}

// A friend's summary sealed for this fused card alone, unless a later card of
// the same fusion still needs it.
async function ownFusionKeys(c, card) {
  const keys = [];
  for (const key of (card.write?.people ?? []).map((person) => person.summary_key)) {
    if (key?.startsWith('fusion:') && (await c.registry.fusion(key.slice(7)))?.card_id === card.id) keys.push(key);
  }
  return keys;
}

// A display name, printed on the public card, so held to the concept's rule.
function cardName(value, code = 'invalid_concept') {
  const name = displayName(value) || null;
  const slip = name && identifierIn({ name });
  if (slip) throw new ApiError(400, code, `Take personal details out of the name (cards are public): it looks like it holds ${slip.kind}.`);
  return name;
}

// Accepts {concept, name}, a bare concept, or the assistant's whole reply as a
// string (its ZKAds JSON block is found and checked).
function conceptFrom(body) {
  const raw = body && typeof body === 'object' && 'concept' in body ? body.concept : body;
  try {
    return typeof raw === 'string' ? parseConcept(raw) : validateConcept(raw);
  } catch (error) {
    throw new ApiError(400, 'invalid_concept', error.message);
  }
}

async function cardStatus(c, id) {
  await readLimit(c);
  const card = await readCard(c, id);
  if (!card) throw new ApiError(404, 'not_found', 'No card with that id.');
  // Which renderer makes it, for the app's notes on the software behind each
  // stage, and, once it is ready, the pages of its story for the app to show
  // (the same text its public page shows).
  return json({ ...publicCard(card, c.base), renderer: rendererKind(c.env), ...(card.status === 'ready' ? { story: storyOf(card.concept) } : {}) });
}

function storyOf(concept) {
  if (!concept) return null;
  const text = ['era', 'product_name', 'tagline', 'pitch', 'archetype', 'reading', 'stat_value', 'stat_label', 'rabbit_hole', 'era_match', 'artist', 'artist_reason'];
  return {
    ...Object.fromEntries(text.filter((key) => typeof concept[key] === 'string').map((key) => [key, concept[key]])),
    reasons: (concept.reasons ?? []).map(({ you, so }) => ({ you, so })),
    catalogue: (concept.catalogue ?? []).map(({ name, era, teaser }) => ({ name, era, teaser })),
  };
}

// 'phala' for the Phala-hosted render service, 'local' for one on this
// machine (development and tests), otherwise 'remote'.
function rendererKind(env) {
  try {
    const host = new URL(env.ENCLAVE_URL).hostname;
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) return 'local';
    return /(^|\.)phala\.network$/.test(host) ? 'phala' : 'remote';
  } catch {
    return 'remote';
  }
}

function publicCard(card, base) {
  const page = `${base}/c/${card.id}/`;
  const file = (name) => (card.status === 'ready' && card.files.includes(name) ? page + name : null);
  return {
    id: card.id,
    status: card.status,
    step: card.step,
    product_name: card.concept?.product_name ?? (card.kind === 'fusion' ? 'A fused card' : card.write?.kind === 'catalogue' ? card.write.item.name : 'A card from your summary'),
    kind: card.kind ?? 'card',
    // Who writes the concept: the person's assistant, Venice (a catalogue
    // item's public text) or the enclave's confidential model (summaries).
    concept_by: card.write?.kind === 'catalogue' ? 'venice' : card.write || card.kind === 'fusion' ? 'enclave' : 'assistant',
    matching: card.matching?.open && card.matching.until > Date.now() ? { open: true, until: new Date(card.matching.until).toISOString() } : { open: false },
    sponsored: card.sponsor ? { brand: card.sponsor.brand, name: card.sponsor.name } : null,
    // What the page shows (a proved badge still on its way is not claimed yet).
    badge: card.page_badge ?? null,
    update_error: card.last_error ?? null,
    name: card.name,
    status_url: `${base}/v1/cards/${card.id}`,
    page_url: page,
    video_url: file('story.mp4'),
    loop_url: file('ad.mp4'),
    poster_url: file('poster.jpg'),
    attestation_url: file('attestation.json'),
    error: card.error,
    created_at: new Date(card.created_at).toISOString(),
    updated_at: new Date(card.updated_at).toISOString(),
  };
}

// Serves a card's page and media from R2, with byte ranges for video players.
async function cardFile(c, id, requested) {
  const name = requested || 'index.html';
  if (!Object.hasOwn(CARD_FILES, name)) throw new ApiError(404, 'not_found', 'No such file.');
  return storedFile(c, `cards/${id}/${name}`, CARD_FILES[name], name === 'index.html', async () => {
    if (name !== 'index.html') throw new ApiError(404, 'not_found', 'No such file.');
    // Only a page that does not exist yet reaches the registry, so only that is limited.
    await readLimit(c);
    return waitingPage(c, await readCard(c, id));
  });
}

// The landing page's fictional example (its story page, orbit and videos),
// published to R2 by scripts/example.mjs and served like a card's files.
async function exampleFile(c, requested) {
  const name = requested || 'index.html';
  if (!Object.hasOwn(EXAMPLE_FILES, name)) throw new ApiError(404, 'not_found', 'No such file.');
  return storedFile(c, `example/${name}`, EXAMPLE_FILES[name], name === 'index.html', () => {
    throw new ApiError(404, 'not_found', 'The example is not published here.');
  });
}

// One R2 object as a response: conditional requests, byte ranges, HEAD, and
// the sandboxing policy for a `page`. `missing()` answers when it is absent.
async function storedFile(c, key, type, page, missing) {
  const head = c.request.method === 'HEAD';
  const rangeHeader = c.request.headers.get('range');
  let object;
  let range = null;
  let precondition = 0;
  if (head) {
    object = await c.env.MEDIA.head(key);
    precondition = object ? preconditions(c.request, object.httpEtag) : 0;
  } else if (rangeHeader) {
    const meta = await c.env.MEDIA.head(key);
    if (meta) {
      precondition = preconditions(c.request, meta.httpEtag);
      // A stale If-Range means the client's copy changed: send the whole new file.
      const ifRange = c.request.headers.get('if-range');
      range = precondition || (ifRange && ifRange !== meta.httpEtag) ? null : byteRange(rangeHeader, meta.size);
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${meta.size}`, 'x-content-type-options': 'nosniff' } });
      }
      object = precondition ? meta : await c.env.MEDIA.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    }
  } else {
    object = await c.env.MEDIA.get(key, { onlyIf: c.request.headers });
    // R2 says only that a precondition failed; which one decides 412 or 304.
    if (object && !object.body) precondition = preconditions(c.request, object.httpEtag) || (c.request.headers.has('if-modified-since') ? 304 : 412);
  }
  if (!object) return missing();
  const headers = new Headers({
    'content-type': type,
    etag: object.httpEtag,
    'accept-ranges': 'bytes',
    // Re-renders replace files in place, so caches always revalidate (cheap with the ETag).
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (page) headers.set('content-security-policy', pageCsp(c.url.origin));
  if (precondition) return new Response(null, { status: precondition, headers });
  if (head) {
    headers.set('content-length', String(object.size));
    return new Response(null, { headers });
  }
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
    headers.set('content-length', String(range.end - range.start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { headers });
}

// If-Match first (412 when it fails), then If-None-Match (304 when it
// matches, weak tags compared weakly); 0 when the request may go ahead.
function preconditions(request, etag) {
  const tags = (header) => header.split(',').map((tag) => tag.trim());
  const ifMatch = request.headers.get('if-match');
  if (ifMatch && ifMatch.trim() !== '*' && !tags(ifMatch).includes(etag)) return 412;
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && (ifNoneMatch.trim() === '*' || tags(ifNoneMatch).some((tag) => tag.replace(/^W\//, '') === etag.replace(/^W\//, '')))) return 304;
  return 0;
}

// One byte range: "bytes=a-b", "bytes=a-" or "bytes=-n". Anything else
// (several ranges, other units, nonsense) is ignored and the whole file sent;
// a range starting past the end cannot be satisfied.
function byteRange(header, size) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  return end < start ? null : { start, end };
}

// Shown at a card's link until its page exists; it refreshes itself.
function waitingPage(c, card) {
  const drafted = card?.status === 'waiting_summary';
  const making = card && !drafted && card.status !== 'failed' && card.status !== 'ready';
  const message = !card ? 'There is no card at this link.' : drafted ? 'This card is waiting for its owner’s summary, so nothing is being made yet.' : making ? 'This card is still being made. This page refreshes itself.' : 'This card could not be made.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${making ? '<meta http-equiv="refresh" content="10">' : ''}<title>ZK Ads</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f4ee;color:#141413;font:18px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;text-align:center;padding:24px"><div><img src="/logo.png" alt="ZK Ads" width="134" height="40" style="display:block;margin:0 auto 16px"><p style="margin:0">${message}</p></div></body></html>`;
  return new Response(html, {
    status: making || drafted ? 200 : 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': pageCsp(c.url.origin), 'x-content-type-options': 'nosniff' },
  });
}

async function uploadFile(c, id, file) {
  if (!Object.hasOwn(CARD_FILES, file)) throw new ApiError(404, 'not_found', 'No such card file.');
  const type = CARD_FILES[file];
  const job = await jobToken(c);
  const length = Number(c.request.headers.get('content-length'));
  if (!Number.isInteger(length) || length <= 0) throw new ApiError(411, 'length_required', 'Send the file with a Content-Length.');
  if (length > MAX_FILE_BYTES) throw new ApiError(413, 'too_large', 'The file is too large.');
  if (!(await c.registry.beginUpload(id, job, Date.now()))) throw new ApiError(403, 'forbidden', 'This job token cannot write to that card.');
  await c.env.MEDIA.put(`cards/${id}/${file}`, c.request.body, { httpMetadata: { contentType: type } });
  if (!(await c.registry.addFile(id, job, file, Date.now()))) {
    // Its card was deleted while it uploaded: the file goes too.
    if (!(await c.registry.card(id))) await c.env.MEDIA.delete(`cards/${id}/${file}`);
    throw new ApiError(403, 'forbidden', 'This job token cannot write to that card.');
  }
  return json({ ok: true });
}

async function jobStatus(c, id) {
  const job = await jobToken(c);
  // A concept in another script (CJK, say) can run to tens of kilobytes.
  const body = await readJson(c.request, 64 * 1024);
  const update = { status: body?.status };
  if (update.status === 'queued') {
    // A heartbeat from a job still waiting its turn: keeps it from going stale.
  } else if (update.status === 'rendering') {
    if (!STEPS.includes(body.step)) throw new ApiError(400, 'bad_request', `step must be one of ${STEPS.join(', ')}.`);
    update.step = body.step;
  } else if (update.status === 'failed') {
    update.error = displayError(body.error);
  } else if (update.status === 'ready') {
    if (!Array.isArray(body.files) || !body.files.every((file) => Object.hasOwn(CARD_FILES, file))) throw new ApiError(400, 'bad_request', 'files must list card files.');
    update.files = [...new Set(body.files)];
    update.page_badge = cleanBadge(body.badge);
  } else {
    throw new ApiError(400, 'bad_request', 'status must be queued, rendering, ready or failed.');
  }
  // A concept the enclave wrote (a fusion, or from a summary) is kept for the
  // card's record and retries; it comes with progress and again with ready.
  if (body.concept && (update.status === 'rendering' || update.status === 'ready')) {
    try {
      // Checked for personal details where it was written, in the enclave.
      update.concept = validateConcept(body.concept, { stored: true });
    } catch (error) {
      throw new ApiError(400, 'invalid_concept', error.message);
    }
  }
  const result = await c.registry.jobStatus(id, job, update, Date.now());
  if (!result.ok) throw new ApiError(result.status, result.code, result.message);
  if (update.status === 'ready' && result.files) {
    // Files an earlier render made but this one did not (say, a video) go away.
    const stale = Object.keys(CARD_FILES).filter((file) => !update.files.includes(file));
    if (stale.length) await c.env.MEDIA.delete(stale.map((file) => `cards/${id}/${file}`));
  }
  // A proved badge that arrived while this render ran goes on now, in a re-render.
  if (result.followUp) await followUpRender(c, id);
  return json({ ok: true });
}

async function getCap(c) {
  await requireAdmin(c);
  return json(await c.registry.capStatus(Date.now()));
}

async function setCap(c) {
  await requireAdmin(c);
  const { cards_per_day: cap } = (await readJson(c.request, 1024)) ?? {};
  if (!Number.isInteger(cap) || cap < 0 || cap > 100_000) throw new ApiError(400, 'bad_request', 'cards_per_day must be a whole number from 0 to 100000.');
  return json(await c.registry.setCap(cap, Date.now()));
}

async function issueToken(c) {
  await requireAdmin(c);
  const body = (await readJson(c.request, 1024)) ?? {};
  const label = displayName(body.label);
  const days = body.days ?? 30;
  // scope "session" acts like a signed-in person (tests, stage fallbacks); it is the admin's call.
  const scope = body.scope === 'session' ? 'session' : 'agent';
  if (!label) throw new ApiError(400, 'bad_request', 'label is required (who the token is for).');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ApiError(400, 'bad_request', 'days must be a whole number from 1 to 365.');
  const token = `${scope === 'session' ? 'zks' : 'zka'}_${secretToken()}`;
  const now = Date.now();
  const record = { owner: `invitee:${label}`, label, scope, created_at: now, expires_at: now + days * 86_400_000 };
  await c.registry.saveToken(await sha256(token), record);
  return json({ token, label, scope, expires_at: new Date(record.expires_at).toISOString() }, 201);
}

// Opening a card to matching (at most 72 hours) returns a one-use link for
// the person's assistant to upload their history summary straight to the
// enclave. Closing it deletes the summary there.
async function setMatching(c, id) {
  const { open = true, hours = MATCHING_HOURS } = (await readJson(c.request, 1024)) ?? {};
  const member = await requireMember(c);
  if (typeof open !== 'boolean') throw new ApiError(400, 'bad_request', 'open must be true or false.');
  const card = await ownedCard(c, id, member);
  if (!open) {
    await c.registry.setMatching(id, member.owner, null);
    // If the renderer is unreachable, the summary still expires within 72 hours.
    const deleted = await dispatch(c.env, { keys: [`card:${id}`], at: Date.now() }, '/jobs/forget').then(() => true, (error) => (console.error(`forget ${short(id)}: ${error.message}`), false));
    return json({ matching: { open: false }, summary_deleted: deleted });
  }
  if (card.status !== 'ready') throw new ApiError(409, 'not_ready', 'Open a card to matching once it is ready.');
  // A shared card has two owners but one summary slot, so it cannot be matched.
  if (card.co_owner) throw new ApiError(409, 'shared_card', 'A fused card cannot be opened to matching. Open one of your own cards instead.');
  enclavePublic(c);
  // A card opening to matching starts from a fresh summary: one left from
  // before (a stop whose deletion failed) goes first, or matching stays shut,
  // and only links minted after this can seal the new one. (While matching is
  // open, a new seal simply replaces the summary.)
  if (!matchingOpen(card)) {
    try {
      await dispatch(c.env, { keys: [`card:${id}`], at: Date.now() - 1 }, '/jobs/forget');
    } catch (error) {
      console.error(`forget ${short(id)}: ${error.message}`);
      throw new ApiError(503, 'renderer_unavailable', 'The enclave cannot be reached, so matching cannot open right now. Try again in a minute.');
    }
  }
  if (!(await c.registry.hit(`matching:${member.owner}`, 10, DAY, Date.now()))) throw new ApiError(429, 'rate_limited', 'You have opened matching a lot today. Try again tomorrow.');
  const asked = Math.min(MATCHING_HOURS, Math.max(1, Number.isInteger(hours) ? hours : MATCHING_HOURS));
  const now = Date.now();
  // A guest's matching ends with its sign-in, when nobody could stop it any more.
  const until = Math.min(now + asked * 3_600_000, member.event ? member.expires_at : Infinity);
  const span = Math.max(1, Math.ceil((until - now) / 3_600_000));
  if (!(await c.registry.setMatching(id, member.owner, until, member.hash))) throw signedOut();
  return json({ matching: { open: true, until: new Date(until).toISOString() }, upload: await summaryUpload(c, `card:${id}`, member.owner, span), summary_prompt_url: `${c.base}/v1/summary-prompt` });
}

// find_fusion_partner: the enclave ranks the pool against this card's sealed
// summary. Swapping in another matcher (Index Network, say) means changing
// only rankPartners.
async function partners(c, id) {
  const member = await requireMember(c);
  const card = await ownedCard(c, id, member);
  // Each search is a paid model call in the enclave.
  if (!(await c.registry.hit(`partners:${member.owner}`, 30, 3_600_000, Date.now()))) throw new ApiError(429, 'rate_limited', 'That is a lot of searches. Try again in an hour.');
  if (!card.matching?.open || card.matching.until <= Date.now()) throw new ApiError(409, 'not_matching', 'Open this card to matching first (POST /v1/cards/:id/matching).');
  const pool = (await c.registry.poolCards(Date.now())).filter((other) => other.id !== id && ![other.owner, other.co_owner].includes(member.owner));
  const ranked = await rankPartners(c, card, pool);
  const byId = new Map(pool.map((other) => [other.id, other]));
  // Best first; the score itself stays private (it would hint at unnamed overlap).
  return json({ partners: ranked.filter((m) => byId.has(m.card_id)).map((m) => ({ card: partnerCard(byId.get(m.card_id), c.base), reason: m.reason })) });
}

// (Asked even when the pool is empty: the enclave first checks the
// searcher's own summary, which they need to hear about.)
async function rankPartners(c, card, pool) {
  let res;
  try {
    res = await dispatch(c.env, { key: `card:${card.id}`, owner: card.owner, pool: pool.map((other) => `card:${other.id}`) }, '/jobs/match', 120_000);
  } catch (error) {
    if (error.status !== 409) throw error;
    let code;
    try {
      code = JSON.parse(error.detail).error?.code;
    } catch {
      // Not the enclave's JSON: treat it as no summary.
    }
    if (code === 'profile_failed') throw new ApiError(409, 'profile_failed', 'Your summary could not be read just now. Try again in a few minutes, or seal a new one.');
    if (code === 'summary_unreadable') throw new ApiError(409, 'summary_unreadable', 'Your summary could not be read. Seal a new one (open matching again for an upload link).');
    throw new ApiError(409, 'no_summary', 'Upload your history summary for this card first (the upload link from opening it to matching).');
  }
  const { matches = [] } = await res.json();
  return matches.map((m) => ({ card_id: String(m.key).slice(5), reason: m.reason }));
}

// Whether the enclave still keeps a card's media (it sweeps finished cards
// after a week); re-renders and the sponsorships they carry need it.
async function mediaKept(c, id) {
  const res = await dispatch(c.env, { card_id: id }, '/jobs/media');
  return (await res.json()).kept === true;
}

async function limit(c, key, max, windowMs, message) {
  if (!(await c.registry.hit(key, max, windowMs, Date.now()))) throw new ApiError(429, 'rate_limited', message);
}

// Which of these summary keys the enclave holds (it says yes or no, nothing more).
async function sealed(c, keys) {
  const res = await dispatch(c.env, { keys }, '/jobs/sealed');
  return new Set((await res.json()).sealed ?? []);
}

// What a would-be partner may see of a card: its public face, not its owner.
function partnerCard(card, base) {
  const page = `${base}/c/${card.id}/`;
  return { id: card.id, product_name: card.concept?.product_name, name: card.name, page_url: page, poster_url: card.files.includes('poster.jpg') ? `${page}poster.jpg` : null };
}

// Fusions spend a person's sealed summary, so they need the person's own
// passkey session (in the web app), never just an agent's token.
async function requestFusion(c) {
  const { card_id: cardId, partner_card_id: partnerId } = (await readJson(c.request, 1024)) ?? {};
  const member = await requireSession(c);
  const card = await ownedCard(c, String(cardId ?? ''), member);
  const partner = /^[a-z2-7]{20}$/.test(partnerId ?? '') ? await c.registry.card(partnerId) : null;
  const now = Date.now();
  const open = (x) => x?.matching?.open && x.matching.until > now && x.status === 'ready';
  if (!open(card) || !open(partner)) throw new ApiError(409, 'not_matching', 'Both cards must be ready and open to matching.');
  if ([partner.owner, partner.co_owner].includes(member.owner)) throw new ApiError(409, 'own_card', 'Fuse with someone else’s card.');
  if (!(await c.registry.hit(`fusion-requests:${member.owner}`, 30, DAY, now))) throw new ApiError(429, 'rate_limited', 'You have asked for a lot of fusions today. Try again tomorrow.');
  const fusion = {
    id: cardIdValue(),
    status: 'pending',
    a: { card_id: card.id, owner: member.owner, summary_key: `card:${card.id}` },
    b: { card_id: partner.id, owner: partner.owner, summary_key: `card:${partner.id}` },
    created_at: now,
    updated_at: now,
  };
  await c.registry.createFusion(fusion);
  return json(publicFusion(fusion, member.owner, { [card.id]: card, [partner.id]: partner }, c.base), 201);
}

async function listFusions(c) {
  const member = await requireMember(c);
  const fusions = await c.registry.fusionsOf(member.owner);
  const ids = [...new Set(fusions.flatMap((f) => [f.a.card_id, f.b.card_id, f.card_id]).filter(Boolean))];
  const cards = Object.fromEntries((await Promise.all(ids.map((id) => c.registry.card(id)))).filter(Boolean).map((card) => [card.id, card]));
  return json({ fusions: fusions.map((f) => publicFusion(f, member.owner, cards, c.base)) });
}

function publicFusion(fusion, viewer, cards, base) {
  const face = (id) => (id && cards[id] ? partnerCard(cards[id], base) : null);
  return {
    id: fusion.id,
    status: fusion.status,
    direction: fusion.a.owner === viewer ? 'outgoing' : 'incoming',
    from: face(fusion.a.card_id),
    to: face(fusion.b.card_id),
    card: fusion.card_id ? { id: fusion.card_id, status_url: `${base}/v1/cards/${fusion.card_id}`, page_url: `${base}/c/${fusion.card_id}/` } : null,
    upload_needed: fusion.status === 'waiting_summary' && fusion.b.owner === viewer && !fusion.b.card_id,
    created_at: new Date(fusion.created_at).toISOString(),
  };
}

// accept/decline: the partner answers a request from the pool. start: the
// friend who joined through a fusion invite, once their summary is sealed.
async function decideFusion(c, id, action) {
  const member = await requireMember(c);
  const fusion = await c.registry.fusion(id);
  if (!fusion || fusion.b.owner !== member.owner) throw new ApiError(404, 'not_found', 'No such fusion request for you.');
  // Accepting a request spends a sealed summary, as does starting a fusion
  // without a card of the friend's: those take the person's passkey session.
  if (action === 'accept' || (action === 'start' && !fusion.b.card_id)) sessionOnly(member);
  // The invited friend may also decline while their summary is still to come.
  const from = action === 'start' ? 'waiting_summary' : action === 'decline' && fusion.status === 'waiting_summary' ? 'waiting_summary' : 'pending';
  if (fusion.status !== from) throw new ApiError(409, 'not_pending', `This fusion is ${fusion.status.replace('_', ' ')}.`);
  if (action === 'decline') {
    if (!(await c.registry.advanceFusion(id, from, { status: 'declined', updated_at: Date.now() }))) throw new ApiError(409, 'not_pending', 'This fusion was already answered.');
    // A summary uploaded just for this fusion goes with it (a card's stays while it is open to matching).
    if (fusion.b.summary_key?.startsWith('fusion:')) await dispatch(c.env, { keys: [fusion.b.summary_key], at: Date.now() }, '/jobs/forget').catch((error) => console.error(`forget ${short(id)}: ${error.message}`));
    return json({ ok: true, status: 'declined' });
  }
  if (action === 'start' && !fusion.b.card_id && !(await sealed(c, [fusion.b.summary_key])).has(fusion.b.summary_key)) {
    throw new ApiError(409, 'no_summary', 'Upload your summary to the enclave first (the upload link from accepting the invite).');
  }
  const claimed = await c.registry.advanceFusion(id, from, { status: 'starting', updated_at: Date.now() });
  if (!claimed) throw new ApiError(409, 'not_pending', 'This fusion was already answered.');
  try {
    const card = await startFusion(c, claimed);
    return json(publicCard(card, c.base), 202);
  } catch (error) {
    // Nothing was made, so the request can be answered again.
    await c.registry.advanceFusion(id, 'starting', { status: from, updated_at: Date.now() });
    throw error;
  }
}

// A fresh upload link for a friend whose first summary upload did not go through.
async function fusionUpload(c, id) {
  const member = await requireSession(c);
  const fusion = await c.registry.fusion(id);
  // (One made from the friend's card needs no summary: it is started again instead.)
  if (!fusion || fusion.b.owner !== member.owner || fusion.status !== 'waiting_summary' || fusion.b.card_id) throw new ApiError(404, 'not_found', 'No fusion of yours is waiting for a summary.');
  enclavePublic(c);
  await limit(c, `fusion-upload:${id}`, 10, DAY, 'That is a lot of upload links for one fusion. Try again tomorrow.');
  return json({ upload: await summaryUpload(c, fusion.b.summary_key, member.owner, 24), start_url: `${c.base}/v1/fusions/${id}/start` });
}

// Makes the shared card: a slot from the cap, listed for both people, and a
// render job telling the enclave to write the concept from both people's
// profiles and cards.
async function startFusion(c, fusion) {
  const [a, b] = await Promise.all([c.registry.card(fusion.a.card_id), fusion.b.card_id ? c.registry.card(fusion.b.card_id) : null]);
  if (!a?.concept) throw new ApiError(409, 'not_ready', 'The first card is no longer available.');
  if (fusion.b.card_id && !b?.concept) throw new ApiError(409, 'not_ready', 'The second card is no longer available.');
  // A card's summary is used only while its owner still has it open to matching.
  const keyFor = (side, card) => (side.summary_key?.startsWith('card:') && !(card && matchingOpen(card)) ? null : side.summary_key);
  const names = [a.name, b?.name ?? fusion.b.name].filter(Boolean);
  const site = appOrigin(c);
  const now = Date.now();
  const token = secretToken();
  const card = {
    id: cardIdValue(),
    owner: fusion.a.owner,
    co_owner: fusion.b.owner,
    kind: 'fusion',
    parents: [a.id, b?.id ?? null],
    name: names.length === 2 ? displayName(`${names[0]} & ${names[1]}`) : null,
    concept: null,
    write: {
      kind: 'fusion',
      people: [
        { summary_key: keyFor(fusion.a, a), owner: fusion.a.owner, card: a.concept, name: a.name },
        { summary_key: keyFor(fusion.b, b), owner: fusion.b.owner, card: b?.concept ?? null, name: b?.name ?? fusion.b.name ?? null },
      ],
    },
    status: 'queued',
    step: null,
    files: [],
    error: null,
    job: await sha256(token),
    created_at: now,
    updated_at: now,
  };
  const reserved = await c.registry.createCard(card, now);
  if (!reserved.ok) throw new ApiError(429, 'daily_cap', `ZKAds has made all ${reserved.cap} of today's cards. The limit resets at midnight UTC.`);
  // Only a job the renderer took (or may have taken) marks the fusion started;
  // a refused one throws here, and the caller puts the fusion back.
  await dispatchOrRefund(c, card, { card_id: card.id, token, write: card.write, name: card.name, site });
  await c.registry.advanceFusion(fusion.id, 'starting', { status: 'started', card_id: card.id, updated_at: Date.now() });
  return card;
}

// A fusion invite for someone outside the pool, such as a judge at a demo.
// Its code also lets a newcomer join, and its link opens the web app's fuse page.
async function inviteToFuse(c, id) {
  const member = await requireMember(c);
  const card = await ownedCard(c, id, member);
  if (card.status !== 'ready') throw new ApiError(409, 'not_ready', 'Invite someone once the card is ready.');
  const app = appOrigin(c);
  // Each fusion invite also lets one newcomer join, so members get a daily allowance.
  // (A guest, as many as the cards it may make in a day.)
  if (!(await c.registry.hit(`fusion-invites:${member.owner}`, member.event ? GUEST_CARDS : 30, DAY, Date.now()))) throw new ApiError(429, 'rate_limited', 'You have made a lot of invites today. Try again tomorrow.');
  const code = randomCode(INVITE_ALPHABET, 8);
  const now = Date.now();
  const expires = now + DAY;
  // Only accounts can bring newcomers in, not admin test tokens. A guest's
  // invite can too (so the friend can join to fuse), while its event code is
  // open and spending one of the code's uses.
  // Only an invite the person made themselves (a passkey session) may use
  // their sealed summary; one an agent made fuses from the card alone.
  const made = await c.registry.createFusionInvite(await sha256(code), { card_id: id, owner: member.owner, status: 'open', by_session: member.scope === 'session', created_at: now, expires_at: expires }, now, member.owner.startsWith('user:'), member.event ?? null, member.event ? member.hash : null);
  if (!made) throw signedOut();
  const shown = `ZK-${code.slice(0, 4)}-${code.slice(4)}`;
  return json({ code: shown, fuse_url: `${app}/fuse?code=${shown}`, expires_at: new Date(expires).toISOString() }, 201);
}

async function fusionInviteInfo(c, value) {
  await rateLimit(c, 'fusion-invite', 300);
  const invite = await openFusionInvite(c, value);
  const card = await c.registry.card(invite.card_id);
  if (!card) throw new ApiError(404, 'not_found', 'The card behind this invite is gone.');
  return json({ card: partnerCard(card, c.base), expires_at: new Date(invite.expires_at).toISOString() });
}

// The friend claims the invite. With one of their own cards (`card_id`), the
// shared card is written from the two cards and starts at once: no summary
// is spent, so any of their sign-ins will do (a guest's, or their
// assistant's). Without one, they get a one-use link to seal their summary in
// the enclave, which takes their passkey session; then POST
// /v1/fusions/:id/start makes the shared card.
async function acceptFusionInvite(c, value) {
  const { name, card_id: cardId } = (await readJson(c.request, 1024)) ?? {};
  const member = cardId === undefined ? await requireSession(c) : await requireMember(c);
  const invite = await openFusionInvite(c, value);
  const own = cardId === undefined ? null : await ownedCard(c, String(cardId), member);
  if (own && !own.concept) throw new ApiError(409, 'not_ready', 'That card has nothing to fuse yet. Try again once it is being made.');
  if (!own) enclavePublic(c);
  const friendName = cardName(name, 'bad_request');
  const now = Date.now();
  // A shared card made at once needs a place in today's cards, checked before the invite is spent.
  if (own) {
    const { cards_per_day, used_today } = await c.registry.capStatus(now);
    if (used_today >= cards_per_day) throw new ApiError(429, 'daily_cap', `ZKAds has made all ${cards_per_day} of today's cards. The limit resets at midnight UTC.`);
  }
  // (A guest, as many as the cards it may make in a day: a shared card is a card.)
  if (!(await c.registry.hit(`fusion-claims:${member.owner}`, member.event ? GUEST_CARDS : 30, DAY, now))) throw new ApiError(429, 'rate_limited', 'You have joined a lot of fusions today. Try again tomorrow.');
  const inviter = await c.registry.card(invite.card_id);
  // Its owner deleted it: nothing to fuse with, so the invite stays unused.
  if (!inviter) throw new ApiError(404, 'not_found', 'The card behind this invite is gone.');
  const id = cardIdValue();
  const fusion = {
    id,
    status: own ? 'starting' : 'waiting_summary',
    a: { card_id: invite.card_id, owner: invite.owner, summary_key: invite.by_session && matchingOpen(inviter) ? `card:${invite.card_id}` : null },
    b: { card_id: own?.id ?? null, owner: member.owner, name: friendName, summary_key: own ? null : `fusion:${id}` },
    created_at: now,
    updated_at: now,
  };
  const claimed = await c.registry.claimFusionInvite(await sha256(inviteCode(value)), member.owner, fusion, now);
  if (!claimed.ok) throw new ApiError(409, claimed.code, claimed.message);
  if (own) {
    try {
      return json({ fusion_id: id, card: publicCard(await startFusion(c, fusion), c.base) }, 202);
    } catch (error) {
      // Nothing was made, so the friend can start it again (POST /v1/fusions/:id/start).
      await c.registry.advanceFusion(id, 'starting', { status: 'waiting_summary', updated_at: Date.now() });
      throw error;
    }
  }
  return json({ fusion_id: fusion.id, upload: await summaryUpload(c, fusion.b.summary_key, member.owner, 24), start_url: `${c.base}/v1/fusions/${fusion.id}/start`, summary_prompt_url: `${c.base}/v1/summary-prompt` }, 201);
}

async function openFusionInvite(c, value) {
  const code = inviteCode(value);
  const invite = code ? await c.registry.fusionInvite(await sha256(code), Date.now()) : null;
  if (!invite || invite.status !== 'open') throw new ApiError(404, 'not_found', 'This fusion invite was already used or has expired.');
  return invite;
}

function matchingOpen(card) {
  return Boolean(card.matching?.open && card.matching.until > Date.now());
}

async function ownedCard(c, id, member) {
  const card = /^[a-z2-7]{20}$/.test(id) ? await c.registry.card(id) : null;
  if (!card || ![card.owner, card.co_owner].includes(member.owner)) throw new ApiError(404, 'not_found', 'No such card of yours.');
  return card;
}

// A one-use upload link to the enclave, signed with the shared secret so the
// enclave can check it alone. The summary itself never passes through here.
async function summaryUpload(c, key, owner, hours) {
  const now = Date.now();
  // iat makes each link single-use for its key and void once the key is forgotten.
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ k: key, o: owner, iat: now, exp: now + 30 * 60_000, ttl: hours, n: secretToken().slice(0, 22) })));
  const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.ENCLAVE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(payload))));
  return { url: `${enclavePublic(c)}/summaries`, token: `zku.${payload}.${signature}`, expires_at: new Date(now + 30 * 60_000).toISOString(), keeps_hours: hours };
}

// Where people's assistants and browsers reach the enclave directly: https,
// unless this is local development and it runs on this machine. (Deployed,
// a loopback address would send summaries to each visitor's own computer.)
function enclavePublic(c) {
  const base = (c.env.ENCLAVE_PUBLIC_URL || c.env.ENCLAVE_URL || '').replace(/\/+$/, '');
  if (enclaveLive(c.env) && (/^https:\/\//.test(base) || (isLocal(c.url) && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)))) return base;
  throw new ApiError(503, 'renderer_unavailable', 'The enclave is unavailable right now. Try again later.');
}

// Usage numbers from the skill's usage-stats.mjs (the person's own logs)
// become a badge on the card, unless a badge proved with zkTLS is there.
async function postUsage(c, id) {
  const stats = cleanStats(((await readJson(c.request, 4096)) ?? {}).stats);
  const member = await requireMember(c);
  const card = await ownedCard(c, id, member);
  const badge = stats && badgeFromStats(stats);
  if (!badge) throw new ApiError(400, 'bad_request', 'stats must be the output of usage-stats.mjs, with a plausible token count above zero.');
  if (card.badge && card.badge.source !== 'logs') return json({ badge: card.badge, card: publicCard(card, c.base), note: 'This card has a proved badge, which is kept.' });
  await limit(c, `usage:${id}`, 5, DAY, 'This card has been updated a lot today. Try again tomorrow.');
  // Each update is a re-render, so an owner of many cards is limited too.
  await limit(c, `usage-owner:${member.owner}`, 20, DAY, 'You have updated a lot of cards today. Try again tomorrow.');
  if (!(await mediaKept(c, id))) throw new ApiError(409, 'too_old', 'This card is too old to change: its media is no longer kept.');
  const token = secretToken();
  const restyled = await c.registry.restyle(id, member.owner, { usage: stats, badge }, await sha256(token), Date.now());
  if (!restyled.ok) throw new ApiError(restyled.code === 'not_found' ? 404 : 409, restyled.code, restyled.message);
  await rerender(c, restyled.card, token);
  return json({ badge, card: publicCard(restyled.card, c.base) });
}

// A Codex usage proof: the enclave opens a Reclaim session (Popcorn, a remote
// browser in a TEE) where the person signs in to ChatGPT; the proof comes
// back to the enclave, which verifies it and tells this worker the count.
async function startCodexProof(c, id) {
  const member = await requireMember(c);
  const card = await ownedCard(c, id, member);
  if (card.status !== 'ready') throw new ApiError(409, 'not_ready', 'Prove usage once the card is ready.');
  const callbackBase = enclavePublic(c);
  await rateLimit(c, 'proof', 30);
  await limit(c, `proof:${id}`, 5, DAY, 'This card has had a lot of proof attempts today. Try again tomorrow.');
  if (!(await mediaKept(c, id))) throw new ApiError(409, 'too_old', 'This card is too old to change: its media is no longer kept.');
  const session = cardIdValue();
  const expires = Date.now() + 30 * 60_000;
  await c.registry.saveProof(session, { card_id: id, owner: member.owner, status: 'pending', created_at: Date.now(), expires_at: expires });
  const res = await dispatch(c.env, { session, card_id: id, callback_base: callbackBase }, '/jobs/proof', 30_000);
  const { request_url: requestUrl } = await res.json();
  if (!/^https?:\/\//.test(requestUrl ?? '')) throw new ApiError(502, 'proof_unavailable', 'Could not start the proof session.');
  return json({ session, request_url: requestUrl, status_url: `${c.base}/v1/proofs/${session}`, expires_at: new Date(expires).toISOString() }, 201);
}

async function proofStatus(c, session) {
  const member = await requireMember(c);
  const proof = await c.registry.proof(session, Date.now());
  if (!proof || proof.owner !== member.owner) throw new ApiError(404, 'not_found', 'No such proof session (they last 30 minutes).');
  return json({ status: proof.status, card_id: proof.card_id, badge: proof.badge ?? null, error: proof.error ?? null });
}

// The enclave's verdict, sent with the shared service secret.
async function finishProof(c, session) {
  const given = bearer(c.request);
  if (!given || !c.env.ENCLAVE_SECRET || (await sha256(given)) !== (await sha256(c.env.ENCLAVE_SECRET))) throw new ApiError(401, 'unauthorized', 'Service secret required.');
  const body = (await readJson(c.request, 2048)) ?? {};
  const verified = body.status === 'verified' && Number.isFinite(body.tokens) && body.tokens > 0 && body.tokens <= 1e13;
  const result = verified ? { status: 'verified', badge: cleanBadge({ value: formatCount(body.tokens), label: 'Codex tokens', source: body.source === 'fixture' ? 'fixture' : 'zktls' }) } : { status: 'failed', error: displayError(body.error) };
  const token = secretToken();
  const finished = await c.registry.finishProof(session, result, await sha256(token), Date.now());
  if (!finished.ok) throw new ApiError(409, 'not_pending', 'This proof session is not waiting for a result.');
  if (finished.card) await rerender(c, finished.card, token).catch((error) => console.error(`rerender ${short(finished.card.id)}: ${error.message}`));
  return json({ ok: true });
}

// The re-render that brings a card's page in line with its record: a proved
// badge it lacks, or files a failed render left behind (the registry counts
// and bounds these).
async function followUpRender(c, id) {
  const token = secretToken();
  const queued = await c.registry.queueFollowUp(id, await sha256(token), Date.now());
  if (queued.ok) await rerender(c, queued.card, token).catch((error) => console.error(`follow-up ${short(id)}: ${error.message}`));
}

// Re-renders a ready card's page and story after its sponsor or badge
// changed. No media is bought again, so no cap slot is used.
async function rerender(c, card, token) {
  try {
    await dispatch(c.env, { card_id: card.id, token, concept: card.concept, sponsor: card.sponsor ? cleanSponsor(card.sponsor) : undefined, badge: card.badge ? cleanBadge(card.badge) : undefined, usage: card.usage ?? undefined, reuse: true, name: card.name, site: appOrigin(c) });
  } catch (error) {
    if (error.name === 'TimeoutError') return;
    await c.registry.jobStatus(card.id, await sha256(token), { status: 'failed', error: 'The renderer could not be reached to update this card.', unsent: true }, Date.now());
    throw new ApiError(503, 'renderer_unavailable', 'The renderer is unavailable right now, so the card was left as it was. Try again in a few minutes.');
  }
}

// The brands that can win slots: names and taglines only. Bids, targets and
// budgets stay sealed.
async function listBrands(c) {
  const brands = (await c.registry.brands()).filter((brand) => brand.status === 'active');
  return json({ brands: brands.map(({ id, name, product, tagline, fictional }) => ({ id, name, product, tagline, fictional: Boolean(fictional) })) });
}

// The sponsor form: a member enters a brand with play credits. Its name and
// tagline will appear on people's cards, so an admin approves it first.
async function bidBrand(c) {
  const body = (await readJson(c.request, 4096)) ?? {};
  const member = await requireMember(c);
  // An entry's name reaches other people's cards, so a guest saves the account first.
  if (member.event) throw new ApiError(403, 'forbidden', 'Save this guest account with a passkey before entering a brand.');
  await rateLimit(c, 'bid', 30);
  let brand;
  try {
    brand = cleanBrand(body);
  } catch (error) {
    throw new ApiError(400, 'bad_request', error.message);
  }
  const budget = 1000;
  const record = { ...brand, id: `bid-${randomCode(INVITE_ALPHABET, 8).toLowerCase()}`, budget, spent: 0, wins: 0, status: 'pending', owner: member.owner, created_at: Date.now() };
  const added = await c.registry.addBrand(record);
  if (added === 'pending') throw new ApiError(409, 'pending', 'You already have three brands waiting for review.');
  if (added === 'queue') throw new ApiError(409, 'queue_full', 'Many brands are waiting for review. Try again later.');
  if (!added) throw new ApiError(409, 'full', 'The brand roster is full.');
  return json({ id: record.id, status: 'pending', budget, message: 'Thanks. An admin will review your brand before it can win slots.' }, 201);
}

async function adminBrands(c) {
  await requireAdmin(c);
  return json({ brands: await c.registry.brands() });
}

async function moderateBrand(c, id, action) {
  await requireAdmin(c);
  // A rejected entry is removed, so junk cannot fill the roster.
  const brand = action === 'approve' ? await c.registry.setBrandStatus(id, 'active') : await c.registry.removeBrand(id);
  if (!brand) throw new ApiError(404, 'not_found', 'No such brand.');
  return json({ id, status: action === 'approve' ? 'active' : 'removed' });
}

// The owner lets brands bid for one sponsored slot in this card's catalogue.
// The enclave runs the sealed auction; the winner's item is added and the
// page and story re-rendered (no new media, so no cap slot).
async function sponsorCard(c, id) {
  const member = await requireMember(c);
  const card = await ownedCard(c, id, member);
  if (card.status !== 'ready' || !card.concept) throw new ApiError(409, 'not_ready', 'Let brands bid once the card is ready.');
  if (card.sponsor) throw new ApiError(409, 'sponsored', 'This card already has a sponsored item.');
  await limit(c, `sponsor:${id}`, 3, DAY, 'This card has been through the auction a lot today. Try again tomorrow.');
  await limit(c, `sponsor-owner:${member.owner}`, 20, DAY, 'You have run a lot of auctions today. Try again tomorrow.');
  // Settle only if the card can be re-rendered with the item (no media bought again).
  if (!(await mediaKept(c, id))) throw new ApiError(409, 'too_old', 'This card is too old to change: its media is no longer kept.');
  const brands = (await c.registry.brands()).filter((brand) => brand.status === 'active' && brand.budget - brand.spent >= brand.bid);
  const res = await dispatch(c.env, { concept: card.concept, brands: brands.map(({ id: brandId, name, product, tagline, targets, bid }) => ({ id: brandId, name, product, tagline, targets, bid })) }, '/jobs/auction', 120_000);
  const { winner, item } = await res.json();
  const brand = winner && brands.find((b) => b.id === winner.brand_id);
  if (!brand) return json({ sponsored: null, message: 'No brand fits this card closely enough, so nothing was added.' });
  const price = Math.min(brand.bid, Math.max(1, Number(winner.price) || 1));
  const sponsor = cleanSponsor({ brand: brand.name, tagline: brand.tagline, ...item, credits: Math.ceil(price / 2) });
  if (!sponsor) throw new ApiError(502, 'bad_item', 'The sponsored item came back unusable. Try again.');
  const token = secretToken();
  const settled = await c.registry.sponsor(id, member.owner, { ...sponsor, brand_id: brand.id, price }, await sha256(token), Date.now());
  if (!settled.ok) throw new ApiError(409, settled.code, settled.message);
  await rerender(c, settled.card, token);
  return json({ sponsored: { brand: sponsor.brand, name: sponsor.name, teaser: sponsor.teaser, credits: sponsor.credits }, card: publicCard(settled.card, c.base) });
}

// Invite codes, each good for `uses` sign-ups. An event code (`event: true`)
// is one code for a crowd, such as a QR code on a screen: it also lets
// assistants start guest accounts (POST /v1/agent/guest), and it expires
// after `days` (three by default).
async function createInvites(c) {
  await requireAdmin(c);
  const body = (await readJson(c.request, 1024)) ?? {};
  const count = body.count ?? 1;
  const uses = body.uses ?? 1;
  const label = displayName(body.label) || 'invite';
  const event = body.event ?? false;
  const days = body.days ?? (event ? 3 : null);
  if (typeof event !== 'boolean') throw new ApiError(400, 'bad_request', 'event must be true or false.');
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new ApiError(400, 'bad_request', 'count must be a whole number from 1 to 100.');
  if (!Number.isInteger(uses) || uses < 1 || uses > (event ? 10_000 : 1000)) throw new ApiError(400, 'bad_request', `uses must be a whole number from 1 to ${event ? '10000' : '1000'}.`);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 30)) throw new ApiError(400, 'bad_request', 'days must be a whole number from 1 to 30.');
  const app = appOrigin(c);
  const now = Date.now();
  const expires = days ? now + days * DAY : null;
  const codes = Array.from({ length: count }, () => randomCode(INVITE_ALPHABET, 8));
  await c.registry.createInvites(await Promise.all(codes.map(async (code) => ({ hash: await sha256(code), label, uses }))), now, { event, expires_at: expires });
  const shown = codes.map((code) => `ZK-${code.slice(0, 4)}-${code.slice(4)}`);
  return json(
    {
      label,
      uses,
      event,
      expires_at: expires && new Date(expires).toISOString(),
      invites: shown.map((code) => ({ code, join_url: `${app}/join?code=${code}`, ...(event ? { event_url: `${app}/event?code=${code}` } : {}) })),
    },
    201,
  );
}

// Re-sends a card to the renderer with a new job token. Finished media is
// reused and paid jobs still in flight are collected, so this does not pay twice.
async function retryCard(c, id) {
  await requireAdmin(c);
  const token = secretToken();
  const card = await c.registry.restart(id, await sha256(token), Date.now());
  if (!card) throw new ApiError(404, 'not_found', 'No card with that id.');
  try {
    // A concept already written (by an assistant or the enclave) is reused as is.
    // A re-render (a stuck one, or a ready card's retry) must not buy media and,
    // if it fails, leaves the card as it was; a failed card's retry may buy media.
    await dispatch(c.env, { card_id: id, token, ...(card.concept ? { concept: card.concept } : { write: await currentWrite(c, card.write) }), sponsor: card.sponsor ? cleanSponsor(card.sponsor) : undefined, badge: card.badge ? cleanBadge(card.badge) : undefined, usage: card.usage ?? undefined, reuse: Boolean(card.rerender), name: card.name, site: appOrigin(c) });
  } catch (error) {
    if (error.name !== 'TimeoutError') {
      await c.registry.jobStatus(id, await sha256(token), { status: 'failed', error: 'The renderer could not be reached.', unsent: true }, Date.now());
      throw error instanceof ApiError ? error : new ApiError(503, 'renderer_unavailable', `The renderer is unavailable (${error.message}).`);
    }
  }
  return json(publicCard(card, c.base), 202);
}

// A fusion's write as it would be made now: a card's summary goes along only
// while that card is still open to matching (as startFusion decides).
async function currentWrite(c, write) {
  if (write?.kind !== 'fusion') return write;
  const people = await Promise.all(
    write.people.map(async (person) => {
      if (!person.summary_key?.startsWith('card:')) return person;
      const source = await c.registry.card(person.summary_key.slice(5));
      return source && matchingOpen(source) ? person : { ...person, summary_key: null };
    }),
  );
  return { ...write, people };
}

// A renderer address deployed for a while (ENCLAVE_URL_UNTIL, in ms: the
// Venice test tunnel's) is not used after it lapses, so a tunnel that died
// without saying so is not trusted with jobs or summaries for long.
function enclaveLive(env) {
  const until = Number(env.ENCLAVE_URL_UNTIL);
  return !until || until > Date.now();
}

async function dispatch(env, job, path = '/jobs/render', timeoutMs = 15_000) {
  if (!env.ENCLAVE_URL || !env.ENCLAVE_SECRET || !enclaveLive(env)) throw new ApiError(503, 'renderer_unavailable', 'The renderer is unavailable right now. Try again later.');
  const base = env.ENCLAVE_URL.replace(/\/+$/, '');
  // The job carries the shared secret, so it travels over https unless the
  // renderer runs on this machine.
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) throw new Error('ENCLAVE_URL must use https.');
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.ENCLAVE_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A render job that timed out may have been taken, so render callers
    // decide; any other call that timed out, or anything else, means try later.
    if (error.name === 'TimeoutError' && path === '/jobs/render') throw error;
    throw new ApiError(503, 'renderer_unavailable', error.name === 'TimeoutError' ? 'The renderer took too long to answer. Try again in a minute.' : 'The renderer is unavailable right now. Try again in a minute.');
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw Object.assign(new ApiError(res.status === 409 ? 409 : 503, res.status === 409 ? 'conflict' : 'renderer_unavailable', res.status === 409 ? detail : 'The renderer is unavailable right now. Try again in a minute.'), { renderer: res.status, detail });
  }
  return res;
}

// A member's own session (from a passkey) or an agent token they approved.
// Handlers read the request body before this, so a request cannot be held
// open past the end of a sign-in (a revoked token, a saved guest's) and
// still act with it.
async function requireMember(c) {
  const token = bearer(c.request);
  if (!token) throw new ApiError(401, 'unauthorized', 'Send your ZKAds token as "Authorization: Bearer …" (see /skill.md to get one).');
  const hash = await sha256(token);
  const record = await c.registry.token(hash, Date.now());
  if (!record) throw new ApiError(401, 'unauthorized', 'This token is unknown or has expired.');
  return { ...record, hash };
}

// Only a passkey session, never an agent, may approve agents.
async function requireSession(c) {
  return sessionOnly(await requireMember(c));
}

function sessionOnly(record) {
  if (record.scope !== 'session') throw new ApiError(403, 'forbidden', record.event ? 'This is a guest account: save it with a passkey first (the claim link from signing in with the event code, or "Save" in the web app), then do this on the ZKAds site.' : 'Sign in with your passkey on the ZKAds site to do this.');
  return record;
}

async function takeCeremony(c, id, kind) {
  const pending = typeof id === 'string' && id.length < 100 ? await c.registry.takeCeremony(id, Date.now()) : null;
  if (!pending || pending.kind !== kind) throw new ApiError(401, 'expired', 'This passkey request expired. Start again.');
  return pending;
}

async function newSession(userId) {
  const token = `zks_${secretToken()}`;
  const now = Date.now();
  return { token, hash: await sha256(token), record: { owner: `user:${userId}`, label: 'passkey', scope: 'session', created_at: now, expires_at: now + SESSION_DAYS * DAY } };
}

// Card status reads need no token, so floods of them are capped per IP
// before they reach the registry (Workers rate limiting; absent in some local
// setups). Media comes from R2 alone and is not limited.
async function readLimit(c) {
  if (!c.env.READS) return;
  const { success } = await c.env.READS.limit({ key: c.request.headers.get('cf-connecting-ip') ?? 'local' });
  if (!success) throw new ApiError(429, 'rate_limited', 'Too many requests. Slow down and try again in a minute.');
}

// Per-IP limits over 15 minutes. A venue's guests share one public IP, so the
// limits are generous, and RATE_LIMIT_SCALE (say "4") raises them all for an event.
async function rateLimit(c, bucket, limit) {
  const ip = c.request.headers.get('cf-connecting-ip') ?? 'local';
  const scale = Math.max(1, Number(c.env.RATE_LIMIT_SCALE) || 1);
  if (!(await c.registry.hit(`${bucket}:${ip}`, Math.round(limit * scale), 900_000, Date.now()))) throw new ApiError(429, 'rate_limited', 'Too many attempts from this network. Try again in a few minutes.');
}

// The site where people sign in and approve agents, and the passkeys' domain.
// Outside local development these must be configured, so a request's Host
// header can never choose them.
function appOrigin(c) {
  if (!c.env.APP_ORIGIN && !isLocal(c.url)) throw new ApiError(500, 'misconfigured', 'APP_ORIGIN is not set.');
  return (c.env.APP_ORIGIN || c.base).replace(/\/+$/, '');
}

function rpId(c) {
  return c.env.RP_ID || new URL(appOrigin(c)).hostname;
}

function isLocal(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// "ZK-ABCD-2345", "abcd2345" and "zk abcd 2345" are the same invite.
function inviteCode(value) {
  const code = typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ZK(?=.{8}$)/, '') : '';
  return code.length === 8 && [...code].every((ch) => INVITE_ALPHABET.includes(ch)) ? code : null;
}

function randomCode(alphabet, length) {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let code = '';
  while (code.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) if (byte < limit && code.length < length) code += alphabet[byte % alphabet.length];
  }
  return code;
}

async function requireAdmin(c) {
  const token = bearer(c.request);
  const admin = c.env.ADMIN_TOKEN ?? '';
  // Hashing both sides keeps the comparison from leaking the token's bytes.
  if (admin.length < 32 || !token || (await sha256(token)) !== (await sha256(admin))) throw new ApiError(401, 'unauthorized', 'Admin token required.');
}

async function jobToken(c) {
  const token = bearer(c.request);
  if (!token) throw new ApiError(401, 'unauthorized', 'Job token required.');
  return sha256(token);
}

function bearer(request) {
  return request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

// Error text from the renderer, kept to one plain line.
function displayError(value) {
  const line = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  return line.slice(0, 300) || 'Rendering failed.';
}

async function readJson(request, limit) {
  const body = await readText(request, limit);
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new ApiError(400, 'bad_request', 'The body must be JSON.');
  }
}

// Reads at most `limit` bytes, stopping early rather than buffering a huge body.
async function readText(request, limit) {
  const tooLarge = new ApiError(413, 'too_large', 'The request body is too large.');
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw tooLarge;
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw tooLarge;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  chunks.reduce((offset, chunk) => (bytes.set(chunk, offset), offset + chunk.byteLength), 0);
  return new TextDecoder().decode(bytes);
}

// Card ids: 20 characters from a 32-letter alphabet, 100 random bits, so a
// card's link works as an unguessable, unlisted address.
function cardIdValue() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => alphabet[byte & 31]).join('');
}

// 32 random bytes, base64url: 43 characters.
function secretToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function text(value, type = 'text/plain; charset=utf-8') {
  return new Response(value, { headers: { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
}

function problem(status, code, message) {
  return json({ error: { code, message } }, status);
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-max-age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
