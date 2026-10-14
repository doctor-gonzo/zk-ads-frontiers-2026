# Deploying ZKAds

Two pieces go live: the **worker** on Cloudflare (API, web app, card pages)
and the **render service** on Phala Cloud (a TEE). Each holds the shared
`ENCLAVE_SECRET`; only the render service holds the Venice, Confidential AI
and Reclaim keys.

## What the owner provides

| Input | Where it goes |
| --- | --- |
| A Cloudflare account API token (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `.env`), and R2 switched on | lets `npm run deploy` publish the worker |
| A domain (optional), on Cloudflare DNS or GitHub Pages | `APP_ORIGIN`/`RP_ID` (passkeys belong to it: pick it before inviting people) |
| Phala Cloud account, and a Confidential AI API key | the render service's CVM and `CONFIDENTIAL_AI_KEY` |
| Venice API key (already in `.env`) | `VENICE_API_KEY` |
| Reclaim app ID and secret, and a custom provider for ChatGPT's Codex usage page | `RECLAIM_APP_ID`, `RECLAIM_APP_SECRET` (encrypted variables); the provider ID, its exact version and the parameter name go into `enclave/docker-compose.yml` itself |

Keys go into Cloudflare secrets and Phala's encrypted environment variables
directly, never into chat or git.

## 1. Render service on Phala

1. Build the image for Phala's machines (linux/amd64): push to `main` of the
   public repo (the `enclave image` workflow pushes
   `ghcr.io/<owner>/<repo>` and prints its digest), or locally:
   `docker buildx build --platform linux/amd64 -f enclave/Dockerfile -t ghcr.io/<owner>/<repo> --push .`
2. Make the package public in GitHub (Packages → <repo> → settings), so
   Phala can pull it.
3. In `enclave/docker-compose.yml`, set the image to
   `ghcr.io/<owner>/<repo>@sha256:<digest>`.
4. Phala Cloud → Create CVM → docker-compose → paste the file. Add the
   encrypted variables: `ENCLAVE_SECRET` (run
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`),
   `WORKER_URL` (the worker's URL from step 2; edit it in afterwards if
   needed), `VENICE_API_KEY`, `CONFIDENTIAL_AI_KEY`, and `RECLAIM_APP_ID` and
   `RECLAIM_APP_SECRET` once you have them. A 2 vCPU / 4 GB CVM renders one or
   two pages at a time; more cores render faster.
5. The service's URL is `https://<app-id>-8788.<cluster>.phala.network`.
   `GET /health` should answer `"tee": true`.

## 2. Worker on Cloudflare

Put the deployment's settings in `.env` (git-ignored; see `.env.example`):

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`: an account API token
  with Workers Scripts (edit), Workers R2 Storage (edit) and Account Settings
  (read).
- `ZKADS_PUBLIC_URL`: the worker's address, such as
  `https://zkads.<subdomain>.workers.dev`. It is also the web app's origin and
  the passkeys' domain.
- `ZKADS_ADMIN_TOKEN` and `ZKADS_ENCLAVE_SECRET`: 32+ random characters each.
  Phala gets the same `ENCLAVE_SECRET`.
- `ZKADS_ENCLAVE_URL`: the render service's Phala URL, once it runs. Until
  then, making a card answers "renderer unavailable". For your own tests
  before that, `npm run renderer:venice` runs the render service on this
  computer behind a temporary Cloudflare tunnel (it needs `cloudflared`) and
  points the worker at it until you stop it, for 24 hours at most. It is not
  a TEE, so never use it with other people. It shares
  `ZKADS_ENCLAVE_SECRET` with the worker, so give the Phala deployment a
  fresh one (in `.env` and Phala together).

Switch on R2 once in the dashboard, then:

```bash
node --env-file=.env scripts/wrangler.mjs r2 bucket create zkads-media
npm run deploy
```

`npm run deploy` (`scripts/deploy.mjs`) deploys with those settings and sets
the two secrets through stdin. Raise `RATE_LIMIT_SCALE` (say to 4) in
`wrangler.jsonc` on event days, when many people share one public IP.

The deploy also sets up the worker's five-minute cron (`triggers` in
`wrangler.jsonc`): it sends follow-up renders that could not reach the render
service when they were first due.

Admin tokens (`POST /v1/admin/tokens`) belong to the person their `label`
names: two tokens with the same label share cards and summaries, so give
each person their own label.

Make the first invite codes:

```bash
curl -sS -X POST https://<worker>/v1/admin/invites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"count": 20, "label": "frontiers"}'
```

For an event, make one event code instead: a QR code of its `event_url`
lets anyone there start with no sign-up (see "The event code" in
`stage-demo.md`):

```bash
curl -sS -X POST https://<worker>/v1/admin/invites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label": "frontiers", "event": true, "uses": 1000, "days": 5}'
```

Change the daily cap at any time with `POST /v1/admin/cap`
`{"cards_per_day": 500}`.

## 3. Domain (optional)

- **Simplest:** add the domain to Cloudflare (its nameservers at the
  registrar) and set `ZKADS_PUBLIC_URL` to it: `npm run deploy` attaches it
  and its `www.` to the worker as custom domains, and Cloudflare creates the
  DNS records. The web app, API and card pages then share one origin, and
  `app/config.js` (`ZKADS_HOST`) sends other addresses there.
- **Web app on GitHub Pages instead:** publish `app/`, set `window.ZKADS_API`
  in `app/config.js` to the worker's URL, and set the worker's `APP_ORIGIN`
  and `RP_ID` to the Pages domain. Set `window.ZKADS_ENCLAVE` there to the
  enclave's URL too, so the app sends summaries only to it. Give it a custom
  domain of its own: on a shared `<user>.github.io` address, the account's other Pages sites share
  the origin and could read the sign-in session the app keeps in the
  browser. Pages cannot send `app/_headers`, so the page's own CSP still
  applies but nothing stops other sites from framing it; the worker origin
  keeps both.

## 4. The Codex usage provider (Reclaim)

1. Create a Reclaim developer app.
2. With the Reclaim DevTool, add a custom provider for ChatGPT's Codex usage
   page.
   - The login URL is the usage page.
   - The request to match is the page's own call that returns the usage
     numbers.
   - Use a response match that extracts the token total as a parameter, for
     example `tokens`.
3. Check the provider's request match in the DevTool, then write its ID, its
   exact version and the parameter name into `enclave/docker-compose.yml`
   (`RECLAIM_PROVIDER_ID`, `RECLAIM_PROVIDER_VERSION`, `RECLAIM_TOKENS_PARAM`).
   Being in the file, they are part of the attested app: they define what a
   "proved with zkTLS" badge means, and pinning the version means a newly
   published provider version cannot change it (that takes a new compose
   file). The service refuses to start with the placeholders once proofs are
   enabled. Put the app ID and secret into Phala's encrypted variables.
4. Test with `POST /v1/cards/:id/proofs/codex` and open the `request_url`.
   If Popcorn proofs ever arrive without a TEE attestation, change
   `RECLAIM_REQUIRE_TEE` to `"0"` in the compose file (and redeploy).

A card's sound comes from the orbit video's own soundtrack by default (the
default orbit model always makes one, steered by the card's music idea), so
no separate music job is bought. Set `SOUND` to `music` in
`enclave/docker-compose.yml` for a separate music model instead.

The render service keeps each card's media (hero, orbit, music) for 7 days
on its data volume (`CARD_RETENTION_DAYS`), so badges and sponsored items can
be added without paying for media again. A fresh volume, or an older card,
answers `409 too_old` to those changes.

Never deploy with `ENCLAVE_FIXTURE` set: fixture mode is for tests, and its
stand-in matcher reveals words from people's summaries.

## The landing page's example

The fictional Slop Cannon's story page and videos live in R2 under
`example/`, served at `/example/`; its still ships with the app. Publish
them once per bucket (and again whenever the card page's design changes)
from the run folder that made them, as
[`examples/slop-cannon/README.md`](../examples/slop-cannon/README.md)
describes:

```bash
node scripts/example.mjs out/<run>
```

## Checks after deploying

- `GET https://<worker>/skill.md` names the right API and app URLs.
- Open `/event?code=…` on a phone: Copy prompt copies the line with that
  code, and the example card's orbit plays by itself (from
  `/example/orbit.mp4`) and pages through to Fuse.
- Join with an invite on a phone (passkey), approve an agent code, and make a
  card. It should be ready in 2–6 minutes.
- Open a card link on an iPhone (Safari) and an Android phone. The video
  plays, the card flips, and the download buttons work.
