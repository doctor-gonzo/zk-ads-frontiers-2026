# ZKAds stage demo: runbook

For the Paradigm Frontiers demo (day 3, 14 October). Four moments, each live
with a fallback. A real card takes 2–6 minutes to render (the 360° orbit is
the slow part), so the slow steps start early and are revisited.

## The day before

- Deploy (see `deploy.md`) and run the checks at its end on the venue's Wi-Fi
  or a phone hotspot.
- Make three cards in advance on the presenter's account: one plain, one to
  sponsor live, and one to prove Codex usage on. Open each to confirm the
  page and video play. Make them within the week before, on the deployed
  render service: badges and sponsored items need the media it keeps for
  7 days.
- Open the presenter's best card to matching and seal a summary for it,
  so live fusions are made "from both histories".
- Make the event code and print its QR code for the audience (see "The
  event code" below).
- Raise the daily cap if the audience will join (`POST /v1/admin/cap`). The
  audience shares the venue's public IP, so set the worker's
  `RATE_LIMIT_SCALE` to 4 or more for the day (sign-ups, guest sign-ins and
  saving guest accounts each default to 60 per 15 minutes per IP). Card
  status reads have their own limit, 1,200 a minute per IP (`READS` in
  `wrangler.jsonc`), which that setting does not raise; a room of more than
  about 50 people making cards at once needs it raised there, then a
  redeploy.
- Keep the trailer (both cuts) on the laptop as the last resort.

## 1. "My agent made me an ad" (about 2 minutes on stage)

1. In Claude Code, say "Read https://<domain>/skill.md and make me a ZKAds
   card." It signs in with a device code: approve it on your phone before
   the terminal goes on the projector (or keep the code off screen), since
   anyone in the room with an invite could approve it first and your agent
   would then act for their account. Check the account it reports matches
   the "Signed in as" handle on your cards page. Do not give it the event
   code on stage: a guest sign-in prints a link that saves the account, and
   whoever in the room opens it first would own it.
2. It shows what it found and the ad, and sends it straight away: asking
   for the card is the yes.
3. While it renders, switch to the card you made earlier and flip through
   it: the 360° orbit, then the "you" page, the reasons and the catalogue.
4. Come back to the live card at the end of the talk.

*Fallback:* if the agent stalls, paste a saved reply at `/make`, or show the
earlier card.

## 2. Live fusion with a judge (start early, reveal at the end)

1. On screen: your card → "Fuse with someone" → the QR code. It works
   once, for whoever scans it first, so put it up when the judge is ready.
2. The judge scans it on their phone, joins with the invite (one tap for a
   passkey), copies the summary prompt into their own assistant, and pastes
   the summary back. It goes straight into the enclave.
3. Say: "Neither of us sees the other's chats. Inside the enclave, a model
   reads each summary on its own and notes a few harmless traits; the shared
   item is written from those, and the judge's summary is deleted."
4. The shared card renders for both of you (2–6 minutes). Reveal it at the end.

*Fallback:* a fusion made earlier with a teammate; or the judge pastes their
assistant's whole fused-card reply at `/make` (no enclave, said plainly).

## 3. Brands bid blind (about 1 minute)

1. On the prepared card: "Let brands bid". The enclave scores each brand's
   fit against the card's own text, runs a sealed second-price auction, and
   the winner's product joins the catalogue. Bids and scores never leave
   the enclave.
2. Show `/sponsor`: real sponsors at the event can enter a brand with play
   credits (approve them in advance with `/v1/admin/brands`).
3. The card re-renders in about a minute; show the sponsored slot and the
   credits earned.

*Fallback:* a card sponsored earlier.

## 4. A proved Codex badge (about 1 minute plus sign-in)

1. On the prepared card: "Prove Codex usage". Popcorn opens: sign in to
   ChatGPT there (do this beforehand if the venue Wi-Fi is slow, keeping the
   session open).
2. When the proof arrives, the card re-renders with the gold
   "proved with zkTLS" tile.

*Fallback:* a card proved earlier, or the badge "from their own logs"
(`usage-stats.mjs`), labelled as such.

## The event code

One code for the whole audience, as a QR code on screens, posters or
badges. It opens `/event?code=…`, which shows one line to paste into an
assistant:

> Read https://<domain>/skill.md and make me a ZKAds card. Event code: ZK-…

An assistant that can make web requests (Claude Code, Codex, Hermes) signs
itself in as a guest with the code and makes the card: no account and no
approval. It then gives its person a link that saves the account with a
passkey, which fusing needs. The caret on Copy prompt unfolds "read prompt",
which shows the whole line first. For someone with only a chat app, skill.md has the assistant send
them to `/make?code=…`: the page starts the guest account in their browser
and takes the assistant's reply, and "save" in the header adds the passkey
later. People can also create an account with the code straight away
("login", then "Create": a passkey, as with an invite).

The site's own address works without the link too: its line, and Create,
use the event's code from `ZKADS_EVENT_CODE` in `app/config.js` (change or
remove it for another event).

Make it (each guest, sign-up, or newcomer joining through a guest's fusion
invite spends one of `uses`; it stops working after `days`, at most 30):

```bash
curl -sS -X POST https://<domain>/v1/admin/invites \
  -H "Authorization: Bearer $ZKADS_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label": "frontiers", "event": true, "uses": 1000, "days": 5}'
```

Put its `event_url` in the QR code. Guest accounts last as long as the
code, so pick `days` to give people time after the event to save theirs.
Each guest makes at most five cards a day, but whoever has the code can
start more guests, so the daily cap is what bounds the spend. If the code
turns up somewhere it should not, revoke it (`POST /v1/admin/revoke` with
`{"invite": "ZK-…"}`): that also ends every guest it started that has not
been saved (saved accounts stay), so make a new code and put up its QR
code at once.

## Things to say precisely

- History is read only by the person's own assistant, or inside the enclave
  (a Phala TEE) as a sealed summary, which is deleted after 72 hours at most.
- "zkTLS" means the Codex badge only. Nothing else is a zero-knowledge
  proof.
- Image, video and music models (Venice) see only prompts written for the
  card, and, for a card made from a catalogue item, that card's own text;
  never history.
