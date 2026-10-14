# The Slop Cannon

The fictional example on the landing page: a 1/1 product for an imagined
maker, so no one's chat history was read. [`concept.json`](concept.json) is
the concept (valid under `lib/concept.mjs`), and [`run.json`](run.json)
records how its media was made: models, prompts, settings and prices,
without the paid jobs' queue ids or download links.

## Concept review

The handoff's draft kept the name and moved the joke from "AI slop" to the
messy, useful path from rough idea to working software. Changes made before
rendering, and why:

- The burst is one sculpted paper-ribbon swirl fixed to the muzzle, with
  the rubber duck, curly braces and rocket mounted on it. The pipeline asks
  the image model for exactly one object, and the orbit model for one that
  stays still, so a single rigid tableau keeps the props from vanishing or
  morphing between angles.
- Each "why" reason points at something visible in the picture (the volley,
  the green test lights, the brass dial). The draft's swappable cartridges
  were not in the art.
- The reasons are written to follow "→ so …", as the brief asks, because
  the card prints that arrow before them.
- The stat is "1/1 · built around one fictional maker": no invented usage
  counts. The era (San Francisco, 2086) and the catalogue's eras
  (Alexandria's lighthouse, Lyon's Jacquard loom) give the story pages a
  setting. The style credit goes to Charles and Ray Eames, whose toys and
  prototypes were about learning by making; they are not named in the image
  prompt (the brief names only artists who died before 1955).
- None of the old copy ("40% more delve", "0 original thoughts",
  "industrial-strength nonsense", "relentless reprompter", "one terrible
  idea") is used.

## Media

Made on 13 October 2026 with the command-line tool, through Venice, on a
laptop (not in a TEE):

```bash
node zkads.mjs make --concept examples/slop-cannon/concept.json --no-video --hd   # hero.png, gpt-image-2-5-sunburst 2K, $0.15
node zkads.mjs orbit out/<run>                                                    # orbit.mp4, minimax-h3-max-multi-angle 8 s 768p with sound, $0.46
```

The landing page shows a 3:4 cut of each, white-balanced so the opening
frame's backdrop matches the page's ivory:

```bash
ffmpeg -i out/<run>/hero.png -vf "crop=1440:1920:0:200,scale=900:1200:flags=lanczos,colorchannelmixer=rr=1.0082:gg=1.0472:bb=1.0721" -q:v 3 -frames:v 1 app/media/slop-cannon.jpg
ffmpeg -i out/<run>/orbit.mp4 -vf "crop=768:1024:0:96,colorchannelmixer=rr=1.0294:gg=1.0655:bb=1.0917,format=yuv420p" -c:v libx264 -preset slow -crf 23 -profile:v high -movflags +faststart -c:a aac -b:a 128k out/<run>/web/orbit.mp4
```

The still lives with the app (`app/media/slop-cannon.jpg`). The story page,
its videos and the orbit go to R2, served by the worker at `/example/`
(byte ranges, so phones can play them), with:

```bash
node scripts/example.mjs out/<run>
```

That renders the story with the card renderer, marked fictional, uploads
it, and rewrites `run.json`.
