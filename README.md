# ZKAds: an ad for an audience of one

ZKAds reads your chat history and invents a fictional product made just for
you. The product comes from a sci-fi future or a historical era and is drawn in
the style of an artist you like. The result is a story card: the front is an
AI-generated 360° turntable video of the product with period music; behind it,
like a Spotify Wrapped story, pages about you (a title, one stat, your deepest
rabbit hole, who you'd have been in that era), why the item is yours, two more
items from your catalogue, and an invite to fuse your item with a friend's.
The pages are live HTML on the share page and are also exported, with the
orbit and music, as one story video.

There are two ways to run it. The **CLI** (`zkads.mjs`, below) is the
local tool: it runs on your machine, with no TEE, to show what the prompt →
image → 360° flow produces and what it costs. The **hosted version** (see
[Hosted version](#hosted-version-for-agents)) is what assistants use: a
Cloudflare worker plus a render service that runs in a Phala TEE.

## How it works

1. **History.** Your own assistant (Claude or ChatGPT) searches your chats,
   so ZKAds never needs an export.
2. **Concept.** A model writes the product, ad copy, and image and orbit
   prompts as checked JSON, following [the brief](lib/brief.mjs).
   Either your own assistant does it (`prompt`, then `make --concept`), or a
   Venice text model (default Kimi K3, private inference) does it from a
   dossier (`make --history`).
3. **Hero image.** A Venice image model (default GPT Image 2.5 Sunburst) makes
   a 9:16 product shot with no text in it, so the text never warps as it spins.
4. **360° orbit.** Venice's MiniMax H3 Max Multi-Angle accepts an explicit
   camera path. ZKAds sends five keyframes from 0° to 360°, so the clip is a
   true orbit that loops seamlessly rather than a prompt that hopes for one.
5. **Sound.** The orbit model makes the sound along with the video, steered by
   the concept's `music_prompt`, and it plays under the whole story. With
   `--sound music`, a separate Venice music model (default Sonilo) writes an
   instrumental bed as long as the story video instead.
6. **Share.** The story pages are HTML (a period trade card, or a spec sheet
   for sci-fi). Headless Chrome screenshots each page at each reveal step;
   ffmpeg turns those into `story.mp4`: the orbit, a perspective card flip, the
   pages revealing block by block and sliding on, then a flip back so it loops,
   with a paper "swish" on each flip and the music at a steady loudness. The
   share page shows the same pages live: tap the card to step through them.

## Quick start

Requires Node 22.12+ (via nvm), ffmpeg, and Google Chrome (or `CHROME_PATH`)
for the typography.

```sh
cd zkads
cp .env.example .env   # add your VENICE_API_KEY; never paste it into chat
npm test               # offline, no paid calls
npm run quote          # live prices, no key needed
npm run make -- --history samples/sourdough-sre.md
```

The two samples in `samples/` are fictional personas for testing.

## Use your own history

**Route A: your assistant writes the concept (recommended).** Your
history never leaves your assistant; ZKAds receives only the finished concept.

```sh
npm run zkads --silent -- prompt --artist "Moebius" | pbcopy   # artist optional
```

Paste that into Claude (with chat search or memory on). It replies with what it
found, the ad, and a JSON block. Save the whole reply as
`private-data/concept.md` (git-ignored), then:

```sh
npm run make -- --concept private-data/concept.md --name "Charlie"
```

**Route B: Venice writes the concept from a dossier.** Paste
[prompts/search-my-chats.md](prompts/search-my-chats.md) into your assistant,
save the reply as `private-data/dossier.md`, then:

```sh
npm run make -- --history private-data/dossier.md --artist "Moebius" --name "Charlie"
```

Both routes accept `-` to read stdin, e.g. `pbpaste | npm run make -- --concept -`.
Without `--artist`, the model picks an artist the history mentions;
`--era scifi|historical` forces a setting.

**Adding the details about you to an existing card.** Cards made before the
story pages existed (or any card) can get the person details without touching
the product, image, video or music:

```sh
npm run zkads --silent -- prompt out/<run> | pbcopy     # paste into your assistant
pbpaste | npm run zkads -- enrich out/<run> --concept - # after copying its reply
npm run zkads -- share out/<run>                        # free re-render
```

**The buttons on the last pages.** Until there is a hosted app, "Make this one"
copies a prompt for that catalogue item (paste it into your assistant, then
`make --concept`), and "Invite a friend" copies an invite your friend pastes
into their own assistant: it fuses your card with their history into one
shared item, so each history stays with its owner.

## Outputs

Each run writes `out/<timestamp>-<product>/` (git-ignored):

| File | What it is |
| --- | --- |
| `story.mp4` | The whole thing as one video (about 26 s, with sound): orbit, flip, the pages, flip back (loops) |
| `ad.mp4` | The 360° orbit looped to about 16 s with the name and sound; the card's front |
| `index.html` | The story card: tap through the pages; sound, caption, downloads |
| `poster.jpg` | The front as a still |
| `orbit.mp4` | The raw 360° clip |
| `music.*` | The music bed (only with `--sound music`) |
| `hero.png` | The image used for the orbit (each model tried is kept as `hero.<model>.png`) |
| `concept.json` | The product, copy and details about you; edit it and rerun `share` |
| `run.json` | Models, settings, timings and cost; never the raw history |
| `layers/` | The type layer and every page frame, for debugging |

## Iterate cheaply

```sh
npm run make -- --history <file> --no-video                 # about $0.10: concept, image, poster, page
npm run zkads -- image out/<run> --image-model grok-imagine-image-2-0
npm run zkads -- orbit out/<run> --seconds 10 --hd          # 1080p video from a 2K-ready image
npm run make -- --history <file> --sound music              # a separate music model instead of the video's own sound
npm run zkads -- music out/<run> --music-model elevenlabs-music-v2-5
npm run zkads -- share out/<run>                            # free: re-typeset after editing concept.json
```

A paid video or music job is recorded in `run.json` as soon as it is queued.
If a run is interrupted (network drop, Ctrl-C, timeout), rerun that step on the
same folder, e.g. `npm run zkads -- orbit out/<run>`: it collects the job you
already paid for instead of buying a new one. Rerunning `make` starts a new run.

`--hd` asks for a 2K image and 1080p video, so rerun `image` with `--hd` first
if you want the sharper source.

## Cost per ad

Venice list prices, checked 9 October 2026 (`npm run quote` rechecks):

| Step | Default | Price |
| --- | --- | --- |
| Concept | `kimi-k3` | a few cents of tokens |
| Image | `gpt-image-2-5-sunburst`, 1K | $0.07 (2K: $0.15) |
| Orbit | `minimax-h3-max-multi-angle`, 8 s, 768p | $0.46 (1080p: $0.92) |
| Music (only with `--sound music`) | `sonilo-v1-1-music`, about 28 s | $0.09 (ElevenLabs Music: $0.69) |

Roughly **$0.55–0.65 per ad** with the defaults (the orbit makes its own sound). Re-rendering pages and videos
after editing `concept.json` is free.

## Privacy boundary of the command-line tool

- With route A, the history stays with your own assistant; ZKAds and Venice
  see only the finished concept.
- With route B, the history leaves your machine only in the single request to
  the Venice text model. Venice lists Kimi K3 as private (no data retention),
  but nothing is attested; this step trusts Venice.
- The image and video models see only the generated prompts and image, never
  the history. Venice lists the default image model as anonymized (forwarded
  to its provider without your identity) and the orbit model as private.
- The concept prompt limits the ad to harmless themes. That is the model
  following instructions, not a guaranteed filter, so review before sharing.
- ZKAds asks Venice to delete each video and music file after download. For
  the default orbit model Venice has so far answered "Request ID is invalid",
  so deletion of those videos is unconfirmed.
- The music models are listed as anonymized; they receive only the music prompt.

## Hosted version (for agents)

The hackathon version runs as a service that any assistant can use: Claude
Code, Hermes Agent, Muse, or anything that can fetch a URL. The assistant
reads [`skill/SKILL.md`](skill/SKILL.md), writes the concept from its own
memory, and posts only that concept. The design and build order are in
[docs/agent-version-plan.md](docs/agent-version-plan.md).

- **Worker** ([`worker/`](worker/), Cloudflare): the API, `/skill.md`,
  invite codes, event codes (one code for a crowd: an assistant given it
  starts a guest account in one step, saved with a passkey later), passkey
  sign-in, agent sign-in codes, the global daily card
  cap (adjustable live), and card pages and media served from R2 at
  `/c/<id>/`. Card pages are sandboxed: they run as an opaque origin, with no
  cookies or storage.
- **Web app** ([`app/`](app/), static files the worker serves): the landing
  page an event's QR code opens (`/event`, also the signed-out home page),
  with the line to copy into an assistant (readable in full first) and a
  fictional example card, the Slop Cannon
  ([`examples/slop-cannon/`](examples/slop-cannon/)); log in or create an
  account with a passkey from the header, which saves this browser's guest
  account when there is one (`/claim` saves one from an assistant's link);
  approve an assistant's sign-in code, make a card from an assistant's
  reply, follow it while it renders, see your cards, fuse them with someone
  (a QR code invite) or find partners; and an About page (`/about`).
  Browser agents such as Muse sign in at `/agent`.
- **Fusion and matching:** each person's assistant writes a private summary
  that goes straight to the render service, sealed for at most 72 hours.
  There a confidential model (Phala Confidential AI, in a GPU TEE) reads
  each summary alone and writes a short profile: a few harmless traits and
  interest tags. Matching compares the tags in code, and a fusion is written
  from the two profiles, so no model ever sees two summaries together. Only
  the card and a reason naming shared tags come out.
- **AI-usage badges:** a card can show how much its owner uses AI, either
  read from their own Claude Code and Codex logs by
  [`app/usage-stats.mjs`](app/usage-stats.mjs) (only numbers leave the
  computer) or proved with zkTLS: Codex tokens from ChatGPT's usage page,
  through Reclaim's Popcorn browser, verified inside the render service.
- **Sponsored items:** brands (twelve fictional ones, plus any a member enters
  at `/sponsor` and an admin approves) bid play credits for a slot in a
  card's catalogue. A sealed second-price auction in the render service
  weighs each bid by how well the brand fits the card's own text, and the
  winner's product joins the card, reimagined in its era. Brands never learn
  who saw them.
- **Render service** ([`enclave/`](enclave/), a Phala TEE container in
  production): makes the image, orbit and music with Venice, renders the
  story page and video with the same code as the CLI ([`lib/pipeline.mjs`](lib/pipeline.mjs)),
  and uploads them to the worker with a one-card job token. It holds the
  Venice and Confidential AI keys; the worker never does.

Run both locally (Node 22.12+):

```bash
npm install
npm run dev -- --fixture out/<a run folder>
```

`--fixture` reuses that run's image, orbit and music, so nothing is paid for;
leave it off to render with Venice using the key in `.env`. The first run
writes `.dev.vars` with an admin token and the shared service secret, and
prints a `curl` command that makes an invite code. Open
`http://localhost:8787` (passkeys need a domain name, so not 127.0.0.1),
join with the invite, then ask your assistant to read
`http://localhost:8787/skill.md`.

Checks:

```bash
npm run test:e2e
```

That command starts both services with synthetic media and drives them the
way an agent would: tokens, bad concepts, a card from start to finished page,
byte ranges, the sandbox header, job-token isolation, the cap, retries and a
missing renderer. It also opens the web app in headless Chrome with a
virtual passkey to join with an invite, approve an agent, sign back in, and
start and save guest accounts with an event code; and it runs fusion,
matching, sponsored items and usage badges. A second file drives the render
service's job lifecycle against a stand-in worker: token handover on retry,
an unreachable worker, cancellation and restarts. Build the container with
`docker build -f enclave/Dockerfile -t zkads-enclave .`.

## Licence

ZKAds is source-available under the Functional Source License, Version 1.1,
MIT Future License ([FSL-1.1-MIT](LICENSE.md)), © 2026 Charles Thompson. You
may use, change and share it for anything except a competing commercial
service, and each version becomes MIT-licensed two years after its release.
