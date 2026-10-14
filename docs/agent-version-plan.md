# ZKAds agent version: build plan

Decided with the project owner on 9 October 2026, for the Paradigm Frontiers
hackathon (12–14 October, San Francisco). This is the contract the build
follows; change it here first.

## Decisions

| Topic | Decision |
| --- | --- |
| How agents use it | A hosted HTTP API plus a `skill.md` (no MCP). Works from Claude Code, Hermes Agent (Nous Research), Meta's Muse (which drives a browser), and any agent that can fetch a URL. |
| Who writes a card's concept | The person's own assistant first (it sends only the finished concept). Fallback: the assistant uploads a history summary to the enclave, where a confidential model writes the concept. |
| Public front door | A Cloudflare Worker (source-available) for the API, `skill.md`, sign-in, quotas, records and card pages; a static PWA on GitHub Pages under the project's domain. |
| Card pages | Served by the worker at `/c/<id>/` from R2, at an unguessable address. Pages are sandboxed (`Content-Security-Policy: sandbox`): they run as an opaque origin with no cookies, storage or same-origin requests. Their buttons hand off to the PWA. |
| Enclave | A Phala dstack container: renders cards (Node, ffmpeg, Chrome), and runs fusion, matching and the brand auction. It holds the Venice key; the worker never does. Reached at its Phala URL, where TLS ends at Phala's gateway (itself a TEE) and continues over WireGuard into the CVM; with a custom domain and dstack-ingress, TLS can end inside the CVM. |
| Model for history summaries | Phala Confidential AI (GPU TEE, OpenAI-compatible, `https://inference.phala.com/v1`; default `moonshotai/kimi-k3` for concepts and `openai/gpt-oss-120b` for each summary's short profile, both with strict JSON output). Every answer has a receipt ID that anyone can check (a card's page names the one for its concept). History summaries are only ever decrypted inside TEEs. Image, video and music generation stay on Venice; they only see generated prompts. |
| Fusion | Inside the enclave, from both people's history summaries: each is first condensed on its own into a short profile (harmless traits and interest tags), and the fusion is written from the two profiles and cards, so the summaries never meet in one prompt. |
| Matching (`find_fusion_partner`) | Inside the enclave now, behind a provider interface so Index Network can be swapped in later. |
| Retention | A history summary stays sealed in the enclave at most 72 hours. A card's summary is used only for matches and fusions started while the card is open to matching; it is deleted when the person stops matching (if the enclave cannot be reached then, opening matching again deletes it first), and otherwise expires on its own, at most 72 hours after it was sealed. A summary for one fusion or one card is deleted once that concept is written, or within 24 hours. |
| Access | Invite codes unlock passkey sign-in. Agents get scoped, expiring tokens through a device-code approval (the agent shows a short code; the person approves it on the signed-in site), which also works for Muse. |
| Spending | One global cap: 300 cards a day to start, adjustable live by an admin without redeploying. No per-person limit. |
| Brands | Sponsored catalogue item first; other placements (page credit, product placement in the render, brand × item fusion) stay pluggable. Fake comedy brands, plus a bid form where real brands bid play money. The enclave runs the auction. |
| AI-usage stats | Default: a script in the skill reads local Claude Code / Codex logs and sends only the numbers. Toggle: a zkTLS proof of Codex usage from the ChatGPT plan's usage page via Reclaim's Popcorn browser. |
| Live on stage | Agent makes a card; live enclave fusion with a judge; sponsored catalogue item; proven Codex badge. |
| Code | New public `zkads` repo, FSL-1.1-MIT (competing commercial use barred for two years per release, then MIT). |
| Trailer | 60 s landscape plus 30 s vertical from one script, produced by an agent with Venice and ffmpeg. See `trailer-prd.md`. |

## Architecture

```
 person ──► own assistant (Claude Code / Hermes / Muse / any)
               │  reads skill.md, calls the API with an agent token
               ▼
   Cloudflare Worker  ──────────────►  Phala enclave (dstack CVM)
   api.<domain>          job + token     render · fuse · match · auction
   auth, quotas,         (attested)      Phala Confidential AI (GPU TEE)
   records (DO),                         Venice: image · orbit · music
   media (R2),                ▲
   skill.md                   │ history summaries go straight to the
               ▲              │ enclave over TLS that ends inside the TEE
               │              │ (the worker never sees them)
   GitHub Pages PWA ─ card pages, sign-in, approve agents, sponsor form
   <domain>
```

Privacy boundary, stated plainly:
- The worker sees finished concepts, card records and media links, never
  history summaries.
- History summaries go from the person's assistant (or browser) straight to
  the enclave with a one-use upload token the worker signs; the worker never
  handles them. They are decrypted only inside the Phala CPU TEE and the
  Phala GPU TEE used for the model. (On Phala's default URL, TLS ends at
  Phala's gateway, which runs in a TEE, and the connection continues over
  WireGuard into the CVM; a custom domain with dstack-ingress ends TLS inside
  the CVM itself.) Attestation shown on cards and in the PWA comes in stage 4.
- Venice sees generated image, video and music prompts, and, for a card made
  from a catalogue item, that card's own published text (never history).
- The Codex badge is a zkTLS proof; nothing else is called "zero knowledge".

## API (worker), version 1

All endpoints are JSON over HTTPS under `https://api.<domain>/v1`. Agent calls
carry `Authorization: Bearer <agent token>`. Errors: `{ "error": { "code",
"message" } }` with standard HTTP status codes; paid actions return `429`
with `code: "daily_cap"` when the global cap is reached.

### Sign-in and agents

| Method and path | Purpose |
| --- | --- |
| `POST /auth/register/options` `{ invite }` → `POST /auth/register/verify` `{ ceremony, response }` | Join: an invite code unlocks passkey registration; returns a session token (`zks_…`, 30 days) |
| `POST /auth/login/options` → `POST /auth/login/verify` `{ ceremony, response }` | Sign in with the passkey; returns a session token |
| `POST /auth/logout` · `GET /me` | End the session · the member's cards (session or agent token) |
| `POST /agent/device` `{ agent_name }` | Agent starts sign-in; returns `device_code`, `user_code`, `verify_url`, `interval`, `expires_in` (10 minutes) |
| `POST /agent/token` `{ device_code }` | Agent polls: `202 pending`, then `200` with `token` (`zka_…`, 30 days) once; `403 denied`, `404 expired` |
| `GET /agent/device/:user_code` · `POST /agent/approve` `{ user_code, approve }` | The signed-in person sees which agent asks, then approves or declines (session only, never an agent) |
| `POST /agent/guest` `{ code, agent_name }` | With an event code: a guest account (no passkey) and its agent token (`zka_…`) in one step, with no approval, plus the account's handle, `expires_at` and a `claim_url` that saves it (the claim code rides in the link's fragment). The guest lasts as long as the event code (at most 30 days), and revoking the code ends it. `403 not_event_code` for an ordinary invite, `403 bad_code` for an expired, revoked or used-up code |
| `POST /auth/claim/options` `{ claim }` → `POST /auth/claim/verify` `{ ceremony, response }` | Save a guest account: a passkey on that same account, so its cards stay, and a session token. Works once (`404 bad_claim` from options after that, `409` from verify). Saving ends every guest sign-in on the account, takes its cards out of matching, fails its waiting drafts and voids its fusion invites from before (the enclave deletes summaries sealed before), so whoever held a sign-in keeps nothing; the person's assistant signs in again with a sign-in code they approve |

The web app keeps its session token in local storage and calls the API with
bearer tokens, so it works from the worker's origin or from GitHub Pages.
Passkeys belong to `RP_ID` (default: the app's host), so pick the app's
final domain before inviting people. Sign-up, sign-in, guest accounts,
saving them and agent codes are rate-limited per IP. A guest account can do
most of what an approved agent can (make cards, at most five a day, a card
that never reaches the renderer given back; sponsored items, badges,
matching, until its sign-in ends at the latest, and fusion invites, whose
sign-up half works only while the event code is open and spends one of its
uses); entering a brand, and asking for, accepting or joining a fusion,
need it saved first. `GET /me`
says whether the account is a guest (`user.guest`).

### Cards

| Method and path | Purpose |
| --- | --- |
| `GET /skill.md` · `GET /v1/prompt?era` · `GET /v1/schema` | What agents read: the skill, the creative brief with the reply format, the concept's JSON schema |
| `POST /cards` `{ concept, name? }` | Assistant-first: start a card from a finished concept (validated with `validateConcept`; the assistant's whole reply also works). Returns the card: `id`, `status`, `status_url`, `page_url` |
| `GET /cards/:id` | Status (`queued`, `rendering` with `step`, `ready`, `failed`, or `waiting_summary` for a draft), product name, media and attestation links, and the `badge` the page shows. A card silent for 45 minutes is marked failed (an admin can retry it); a re-render (a badge, a sponsored item, a ready card's retry) that fails or goes silent leaves the card `ready` as it was, with `update_error`. If the page then lags the record (a proved badge not shown yet, or files the failed render left), a follow-up render fixes it: at most two that run and fail in a row, sent at once or, while the renderer is unreachable, by a scheduled sweep every five minutes (a send that never reached the renderer does not count). A draft waits a day for its summary |
| `POST /cards/:id/details` `{ details }` | Add the back-of-card details (same rules as `enrich`) |
| `POST /cards/:id/delete` | Delete a card for good, by its owner or co-owner (token or session): its record, its page and media (its link then shows nothing), and the enclave's copy (media and any sealed summary) |
| `POST /cards/:id/catalogue/:n` | "Make this one", by the card's owner or co-owner (the card page's button opens the app's `/catalogue` page, which calls this with the browser's sign-in; assistants call it with their token): the enclave writes a card from catalogue item `n` (0 or 1), through Venice from the card's own text (no history), for that card's own account, so a guest's comes along when it is saved. Each item is made once; asking again returns that card (unless it failed) |
| `POST /cards/:id/usage` `{ stats }` | Usage numbers from `usage-stats.mjs` (served at `/usage-stats.mjs`): a badge labelled "from their own logs", unless a proved one is there |
| `POST /cards/:id/proofs/codex` · `GET /proofs/:session` | Start a Codex usage proof: returns `request_url` (a Popcorn session) and `status_url`; the enclave verifies the proof and the card gets a badge labelled "proved with zkTLS" |
| `POST /cards/from-summary` · `POST /cards/:id/upload` · `POST /cards/:id/start` | The fallback: a card waits (uncounted, at most five per member, for a day) for a summary uploaded to the enclave; `upload` gives a fresh link; `start` takes a cap slot and the enclave writes the concept |

### Fusion and matching

| Method and path | Purpose |
| --- | --- |
| `GET /summary-prompt` | The prompt a person's assistant uses to write their private summary |
| `POST /cards/:id/matching` `{ open }` | Opt in for up to 72 hours: returns an upload link (`url` on the enclave, one-use `token`) for the history summary. `open: false` closes matching and deletes the summary |
| `GET /cards/:id/partners` | `find_fusion_partner`: candidates from the enclave's matcher with a one-line reason each (only harmless overlap). The ranking sits behind `rankPartners`, so Index Network can replace it |
| `POST /fusions` `{ card_id, partner_card_id }` · `GET /fusions` | Request a fusion (both cards open to matching) · incoming and outgoing requests |
| `POST /fusions/:id/accept` · `/decline` | The partner answers; accepting makes the shared card: the enclave writes its concept from both people's profiles and cards, then renders it, listed for both people |
| `POST /cards/:id/invite` | A fusion invite (code plus link to the PWA's fuse page, 24 hours, once) for someone not in the pool; the code also lets a newcomer join |
| `GET /fusion-invites/:code` · `POST /fusion-invites/:code/accept` `{ name? }` | The card behind an invite · the friend claims it and gets an upload link for their summary |
| `POST /fusions/:id/upload` · `POST /fusions/:id/start` | A fresh upload link · make the shared card once the friend's summary is sealed |

### Brands

| Method and path | Purpose |
| --- | --- |
| `GET /brands` | Active brands (fake roster plus approved bids): names, products and taglines only |
| `POST /brands/bids` | Sponsor form: name, product, tagline, target traits, bid per slot in play credits (members only, admin-moderated, 1,000-credit budget) |
| `POST /cards/:id/sponsor` | The enclave runs the sealed second-price auction for this card and adds the winner as a sponsored catalogue item; the owner earns credits (`GET /me` shows them) |

### Admin

`GET`/`POST /admin/cap` `{ cards_per_day }` · `POST /admin/invites`
`{ count, uses?, label?, event?, days? }` (codes like `ZK-ABCD-2345` with
join links; `event: true` makes an event code, one code for a crowd that
also starts guest accounts, with an `event_url` for its QR code, up to
10,000 uses, and an expiry after `days`, three by default) ·
`POST /admin/tokens` `{ label, days? }` (agent tokens without an account, for
testing and stage fallbacks) · `POST /admin/cards/:id/retry` ·
`GET /admin/brands` · `POST /admin/brands/:id/approve` (or `/reject`) ·
`POST /admin/revoke` `{ token }`, `{ owner }` (for an unsaved guest, also
its claim code, and its cards leave matching) or `{ invite }` (an invite or event code; the event code's
unsaved guests lose their sign-ins and their cards leave matching, and other
accounts it made stay). Admin
is a separate token held by the owner.

### Card pages and the renderer's callbacks

`GET /c/:id/` serves the page, and `GET /c/:id/{story.mp4,ad.mp4,poster.jpg}`
serves the media with byte ranges. Until the page exists, a self-refreshing
"still being made" page is shown instead. The enclave reports back with the
card's job token: `PUT /internal/cards/:id/files/:name` and `POST
/internal/cards/:id/status`. The token is replaced on retry and retired when
the card is ready or failed.

## Enclave service (Phala), internal

Reached at its Phala URL (TLS to Phala's gateway, then WireGuard into the
CVM). Three kinds of caller:
- **The worker**, with the shared service secret: `POST /jobs/render` (a
  render job carrying a concept, or `write` for a fusion or a summary card),
  `/jobs/match`, `/jobs/auction`, `/jobs/proof`, `/jobs/sealed`,
  `/jobs/forget`.
- **Agents and browsers**, with a one-use upload token the worker signs:
  `POST /summaries` (history summary upload, `Authorization: Bearer zku.…`).
- **Reclaim**, posting a finished Codex proof: `POST /proofs/callback`.

Each card rendered inside the CVM also gets `attestation.json`: a TDX quote
whose report data is the SHA-256 of a statement listing the card's files and
their hashes.

Jobs reuse `lib/` (concept validation, Venice client, paid-job runner, share
renderer). Media goes back through the worker's `/internal` routes with the
card's job token. A render job carries a finished concept or `write` (fuse two
people, or write from one summary), in which case the enclave writes the
concept first with Phala Confidential AI. Summaries are files on the CVM's
encrypted data volume, uploaded with a one-use token the worker signs (HMAC
with the shared secret), deleted after 72 hours at most, on opt-out, or (for
a fusion invite) once the shared concept is written. `POST /jobs/sealed`
tells the worker only whether a key is held; `POST /jobs/forget` deletes.

The worker is trusted to decide whose summaries are combined: it checks
that both people agreed (an invite, or an accepted request), and it never
sees a summary. A worker that misbehaved could still pair someone's sealed
summary with one it wrote itself, but even then the model writing the fusion
sees only that person's short profile, never the summary. Having the enclave
check consent itself (a key that only the uploader holds, signing each
fusion) is a later step. The worker also tells people where to upload (the
enclave's address, `ENCLAVE_PUBLIC_URL`), so the boundary assumes an honest
worker; a web app hosted elsewhere can pin the enclave's origin
(`window.ZKADS_ENCLAVE` in `app/config.js`), and it then sends summaries
nowhere else. An owner can delete a card for good (`POST /cards/:id/delete`),
which also tells the enclave to drop its copy and summaries.

No model ever sees two people's summaries together. When a summary is
sealed, a model reads it alone and writes a short profile: up to 12 interest
tags (the usage numbers add habit tags such as "night owl") and up to 6
harmless traits written to be shown on a card, none copying six words in a
row from the summary. A fusion is written from the two profiles and cards,
so the most one person's text could make the model repeat about the other is
that profile.

Matching is a provider interface: `rank(card, pool) → [{ card_id, reason }]`
(`rankPartners` in the worker). The enclave provider ranks in plain code
over shared tags, and each reason is built from tags both people have, so a
crafted summary cannot extract anyone else's. An Index Network provider can
replace it without changing the API.

## skill.md (what agents read)

Served at `https://api.<domain>/skill.md` (and `https://<domain>/skill.md`). In
the Agent Skills format (front matter with name and description), with:
how to sign in with a device code; how to write a concept from your own
memory using the brief (linked) and post it; the summary-upload fallback; how
to poll status and share the page; fusion, matching and sponsorship calls;
the local usage-stats script; plain curl examples for every call; the privacy
rules the agent must follow.

## Build order (each stage is demo-able on its own)

1. **Worker core:** cards from concepts, status, records (one Durable
   Object), media (R2), global cap, admin cap and agent tokens, `skill.md`.
   Rendering runs in a local container first (same image as the enclave).
   *Done locally on 10 October; `npm run test:e2e` covers it. Not yet built:
   `/details`, catalogue cards, invites (stage 2).*
2. **Sign-in:** invite codes, passkeys (adapting the chatbox.tv game's
   SimpleWebAuthn worker code in this repo), device-code agent tokens.
   *Done locally on 10 October; the e2e test joins, approves an agent and
   signs back in with a virtual passkey in headless Chrome.*
3. **PWA:** card pages (the existing story page), join, approve agent.
   *Built: `app/` (served by the worker, deployable to GitHub Pages) has
   join, sign in, approve, the browser-agent sign-in, make a card (or let the
   enclave write it from a summary), card progress, "your cards", connected
   assistants, fusion invites with a QR code, the fuse and match pages, the
   sponsor page, and the Codex proof action.*
4. **Enclave:** deploy the container to Phala; attestation shown on cards;
   summary upload; concept from summary via Phala Confidential AI.
5. **Fusion and matching** in the enclave; live two-person demo path.
   *Built on 10 October and tested in fixture mode (a stand-in writer and a
   shared-word matcher replace the model): fusion invites with a QR code,
   summaries sealed straight from the browser, the pool, partners, requests.
   Needs the Phala Confidential AI key for real concepts.*
6. **Brands:** fake roster, sponsor form, auction, sponsored catalogue item.
   *Built on 10 October (`lib/brands.mjs`): the twelve fictional brands seed
   the roster; members enter brands through `/sponsor` (1,000 play credits,
   admin-approved); `POST /cards/:id/sponsor` runs a sealed second-price
   auction on bid × fit in the enclave (fit computed in code from the card's
   own text, so the winner reveals nothing private), adds the winner's
   product reimagined in the card's era as a third catalogue item, credits
   the owner half the price, and re-renders the page and story without
   buying media.*
7. **Codex proof:** Reclaim provider for the Codex usage page, Popcorn flow,
   badge.
   *Plumbing built on 10 October and tested end to end in fixture mode. The
   enclave opens a Reclaim session (`@reclaimprotocol/js-sdk` 5.8, portal
   mode, which is Popcorn) with its own callback and a context bound to the
   ZKAds session. It verifies the posted proof (witness signatures, provider
   hashes, Popcorn's TEE attestation unless `RECLAIM_REQUIRE_TEE=0`) and
   checks the session binding, uses it once, and sends only the token count
   to the worker, which adds a "proved with zkTLS" badge and re-renders. The
   local-logs badge (`app/usage-stats.mjs` → `POST /cards/:id/usage`) is done
   too. Needs from the owner: Reclaim app ID and secret, and a custom provider
   for the ChatGPT Codex usage page whose extracted parameter is the token
   count. Known issue: the SDK depends on node-forge, which has an unpatched
   RSA signature-verification advisory (GHSA-86w9-cpqp-85rv); badges are gated
   on the witnesses' ECDSA signatures and the session binding as well.*
8. **Polish:** stage script, fallbacks, trailer handoff.

Fallbacks if time runs out: stages 6–7 can run with the enclave in a local
container (clearly labelled "not attested"); the Codex badge can use a
recorded proof; the trailer covers anything not live.

## Inputs needed from the owner, and when

| Input | Needed at |
| --- | --- |
| Cloudflare account access for `wrangler deploy` | stage 1 deploy |
| Domain, and GitHub Pages set up for it | stage 3 deploy |
| Phala Cloud project and Confidential AI API key | stage 4 |
| Reclaim developer app ID and secret | stage 7 |
| Licensor legal name for the FSL-1.1-MIT notice | before publishing the repo |
| Index Network contact's answers (hosted agents, API for incognito signals, a Frontiers community) | when choosing the matching provider |
