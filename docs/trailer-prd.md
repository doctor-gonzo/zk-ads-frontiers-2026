# ZKAds trailer: production handoff (PRD)

**For:** an agent session (or editor) producing the trailer with Venice AI
models and ffmpeg. **From:** the ZKAds team. **Status:** ready to produce;
open items are listed at the end.

## 1. What ZKAds is (for the producer)

ZKAds reads a person's AI chat history and invents a fictional product made
just for them, from a sci-fi future or a historical era, drawn in the style of
an artist they like. The output is a story card: an AI-generated 360° product
orbit with period music on the front, then pages about the person (a title,
one stat, their deepest rabbit hole, who they'd have been in that era), why
the item is theirs, two more items from their catalogue, and an invite to fuse
items with a friend.

The privacy idea: the history is only read inside attested hardware enclaves
(Phala TEEs). Brands can bid to place a sponsored item in someone's catalogue
without ever learning who they are. One stat (Codex tokens used) is proven
with a zkTLS proof (Reclaim's Popcorn browser), not just claimed.

Pitch line: **"An ad for an audience of one."** Secondary: **"Ads that know
you. Advertisers that learn nothing."**

## 2. Goals

1. Explain ZKAds to Paradigm Frontiers judges and attendees (crypto and AI
   engineers) in under a minute, and make them laugh at least twice.
2. Show the four live demo moments so the stage demo feels familiar:
   an agent makes a card; a live fusion of two people's items in an enclave;
   brands bidding blind for a sponsored catalogue slot; a proven Codex badge.
3. Give a vertical cut people will repost.

Non-goals: technical depth (attestation internals, proof systems), pricing,
or a product roadmap.

## 3. Deliverables

| Deliverable | Spec |
| --- | --- |
| Master trailer | 60 s ± 3 s, 1920×1080, 24 fps, H.264 (CRF ≤ 18), AAC 192 kb/s, loudness −14 LUFS integrated, true peak ≤ −1 dBTP |
| Vertical cut | 30 s ± 2 s, 1080×1920, same codecs and loudness, cut from the same script and assets |
| Captions | Burned in for the vertical cut; SRT files for both cuts |
| Stills | 3 thumbnails per cut (1920×1080 and 1080×1920), plus the end card as a PNG |
| Project folder | `zkads/trailer/` (see section 10): script, shot list, prompts, generated assets, ffmpeg scripts, cost log |

## 4. Audience and tone

- Audience: engineers, researchers and founders at Frontiers; crypto-literate,
  AI-literate, allergic to hype. Jokes should reward knowing what a mempool,
  a rollup or quadratic voting is, without requiring it.
- Tone: deadpan. A grand Belle Époque catalogue voice describing absurdly
  specific products, cut against crisp modern product-launch visuals. Never
  mean, never cringe-hype ("revolutionary", "game-changing" are banned words).
- Visual language: cream paper, double rules and Didot type (the card back's
  trade-card style); spinning hero objects on dark backgrounds; the ZKAds
  wordmark (ZK in ink, ADS in gold `#E8C77A`).

## 5. Story (60 s master)

Times are targets. "VO" is voiceover, "SFX" sound effect, "TXT" on-screen text.

| Time | Picture | Sound and text |
| --- | --- | --- |
| 0–5 s | A Belle Époque catalogue page flips open; every product on it is generic (a "Hat", a "Lamp"). Slow push-in. | VO: "Every ad you've ever seen was made for a million people." SFX: page turn. |
| 5–8 s | The page tears away to black. One spotlight. | VO: "This one was made for you." Music: waltz begins. |
| 8–16 s | Split screen: a terminal (Claude Code) and a phone (Muse) receive "make me a ZKAds card". The agent's reply streams: "searching my chats… keeping it harmless…". | TXT: "Your own assistant reads your history." |
| 16–24 s | The phonograph (Le Phonographe Quadratique) materializes and makes a full 360° orbit; the name sets in Didot above it. | VO: "Le Phonographe Quadratique. Paris, 1900. Three votes cost nine jetons." |
| 24–31 s | The card flips: "Made for The Encore Economist", the stat tile, the rabbit hole, the era match appear one by one; a gold seal stamps "Proved with zkTLS: 41M Codex tokens". | VO: "It knows your obsessions. It can even prove your token habit." SFX: rubber-stamp thunk. |
| 31–37 s | An animated vault labelled "TEE" closes around a glowing scroll ("your chats"); a check mark: "Attested ✓". | VO: "Your history is only read inside a sealed enclave. Not by us. Not by anyone." |
| 37–45 s | Two phones, two cards. Their items spin toward each other and fuse into a new object (a phonograph that proofs sourdough). | VO: "Meet someone. Fuse your items. Neither of you sees the other's chats." TXT: "You both: fair votes, 2 a.m. rabbit holes" |
| 45–55 s | A tiny auction house: fake brand mascots raise paddles behind a curtain (they can't see the person). Squared Soda wins; its can appears in the catalogue page, labelled "Sponsored · you earned 12 credits". | VO: "Brands bid to be in your catalogue. They never learn who you are." SFX: gavel. |
| 55–60 s | End card on cream paper: wordmark, line, URL, "Built at Paradigm Frontiers 2026", small credits (Venice · Phala · Reclaim). | VO: "ZKAds. An ad for an audience of one." Music: final chord. |

### Voiceover script (exact; about 110 words at a calm pace)

> Every ad you've ever seen was made for a million people.
> This one was made for you.
> Le Phonographe Quadratique. Paris, 1900. Three votes cost nine jetons.
> It knows your obsessions. It can even prove your token habit.
> Your history is only read inside a sealed enclave. Not by us. Not by anyone.
> Meet someone. Fuse your items. Neither of you sees the other's chats.
> Brands bid to be in your catalogue. They never learn who you are.
> ZKAds. An ad for an audience of one.

## 6. Vertical cut (30 s)

Same voice, music and assets; reframe for 9:16 with captions burned in
(bottom third, cream text on a soft dark band, Avenir Next semibold).

| Time | Beat |
| --- | --- |
| 0–3 s | "This ad was made for exactly one person." (hook text over the spinning phonograph) |
| 3–10 s | Agent prompt → phonograph orbit with name |
| 10–17 s | Card flip: title, stat, proven Codex seal |
| 17–24 s | Fusion of two items |
| 24–28 s | Blind brand auction, Squared Soda wins |
| 28–30 s | End card |

## 7. Fake brands (comedy roster)

All fictional. Each brand "targets" traits, which is how the sealed-bid
auction picks a winner for a card. Use these in the auction scene and as
sponsored catalogue items. The trailer features Squared Soda winning; show at
least four others raising paddles.

| Brand | Product | Tagline | Targets |
| --- | --- | --- | --- |
| Squared Soda | Fizzy drink in a brass-capped bottle | "Every sip costs the square of the last." | voting mechanisms, game theory |
| Encore & Sons Wax Co. | Unrewritable wax cylinders | "Pressed once. Argued forever." | music, tamper-evident records |
| Gas Fee Cologne | Fragrance in a ledger-shaped flask | "Smells like 3 a.m. in the mempool." | late nights, crypto |
| Proof-of-Toast | Toaster that stamps each slice | "Every slice, notarised." | verification, breakfast |
| Latency Lager | Beer served in exactly 400 ms | "Brewed for the impatient." | performance, systems |
| Rollup Croissants | Pastry | "Settles on your plate. Eventually." | layer 2s, baking |
| Merkle Moustache Wax | Grooming tin | "Every hair, provably accounted for." | data structures, style |
| Oracle Umbrellas | Umbrella with a tiny ticker | "Knows it rained. Twelve blocks later." | weather, oracles |
| Validator Valet | Parking service | "Your car, parked by two-thirds consensus." | consensus, cars |
| Testnet Tea | Tea with free refills | "Unlimited refills. Worth nothing." | testing, tea |
| Sourdough Uptime Bakery | Starter in a server rack | "99.9% rise availability." | baking, on-call life |
| Seed Phrase Seed Co. | Packet of twelve bulbs | "Twelve words. Twelve tulips. Don't lose them." | gardening, wallets |

Rules: no real company names, logos or trademarks; no real people's likeness;
avoid any brand that mocks a real project or person. Check each name with a
quick web search before publishing and rename any that turn out to be real.

## 8. Production pipeline (for the producing agent)

1. **Set up** `zkads/trailer/` with `script.md`, `shots.json` (one entry per
   shot: id, duration, cut membership, prompt, source, status) and
   `cost-log.md`. Read `zkads/README.md` and `zkads/lib/venice.mjs` for the
   Venice client; reuse it rather than writing a new one.
2. **Reuse existing renders first.** The phonograph assets live in the run
   folder `zkads/out/*-le-phonographe-quadratique/`
   (`orbit.mp4`, `hero.png`, `poster.jpg`, `story.mp4`, `layers/page-*.png`).
   The story pages can be re-rendered from HTML at any size with
   `node zkads.mjs share <run>`.
3. **Generate missing shots with Venice:**
   - stills with an image model (default `gpt-image-2-5-sunburst`, 1K;
     use `2K` for anything shown full screen in the master),
   - motion from stills with an image-to-video model (the orbit model
     `minimax-h3-max-multi-angle` for spins; a general image-to-video model
     for scenes such as the auction and the vault),
   - fake brand products as hero shots in the card's Belle Époque style.
   Quote each video job first (`/video/quote`) and log the cost.
4. **Fake UI** (terminal, phone, card pages): build them as HTML and
   screenshot with headless Chrome (see `screenshotHtml` in
   `zkads/lib/share.mjs`), or screen-record the real app once it is live.
   Never show real personal data, real API keys or real chat content.
5. **Voiceover:** Venice text-to-speech (try `tts-elevenlabs-turbo-v2-5` and
   `tts-kokoro`; pick a calm, slightly grand narrator). Keep the script
   exactly as written in section 5.
6. **Music:** one Venice music bed, a Belle Époque waltz that lifts into a
   light modern pulse at 31 s (two generations crossfaded is fine). Normalize
   with the same approach as `musicGain` in `zkads/lib/share.mjs`.
7. **Edit with ffmpeg:** cut to the beat sheet, add SFX (page turn, stamp,
   gavel; synthesize or use CC0 sounds and record their source), mix VO over
   music with ducking, burn captions for the vertical cut, export both cuts.
8. **Check** against section 9, then hand back the two MP4s, stills, SRTs and
   the cost log.

Budget guide: about $10 of Venice credit for the whole trailer (images about
$0.07–0.15 each, short video clips about $0.35–1.30 each, music about
$0.10–0.70, voiceover a few cents). Stop and ask before exceeding $25.

## 9. Acceptance criteria

- Both cuts hit their durations, resolutions, codecs and loudness targets.
- The VO matches the script word for word and is intelligible over music.
- Every fake brand on screen is from section 7 (or approved additions), and
  none is a real trademark.
- No real personal data, chat content, keys or private URLs appear anywhere.
- Claims stay accurate: say "enclave" or "TEE" for the history processing and
  "zkTLS" only for the Codex badge; never claim the whole system is a
  zero-knowledge proof.
- Captions match the VO; nothing important sits outside the safe areas
  (5% margins; vertical: keep text above the bottom 15%).
- The cost log totals all Venice spend.

## 10. Open items

| Item | Owner | Needed by |
| --- | --- | --- |
| Final domain/URL for the end card | ZKAds team | before final export |
| Real card or the sample persona? The script uses the phonograph card; confirm its owner is happy to show it publicly | card owner | before generating card shots |
| Real "Encore Economist" title and stat (from the enrich step) or placeholders | ZKAds team | before the card-flip shot |
| Narrator voice choice | producer proposes 2 options | first rough cut |
| Partner logos (Venice, Phala, Reclaim) on the end card: allowed? | ZKAds team | before final export |
