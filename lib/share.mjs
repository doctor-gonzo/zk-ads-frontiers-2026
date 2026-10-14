// Packages a run into shareable files. The card's front is the 360° orbit with
// the name set in type; behind it sit live HTML pages about the person (you,
// why it's yours, more from your catalogue, make one together). The same page
// HTML is screenshotted by headless Chrome so ffmpeg can export everything as
// one story video. Outputs: ad.mp4 (orbit loop + music), story.mp4 (orbit,
// card flip, pages, flip back; loops), poster.jpg and index.html.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildClaudePrompt, TYPEFACES } from './concept.mjs';
import { digest } from './media.mjs';

const execFileAsync = promisify(execFile);
// Chrome and ffmpeg get only what they need to run, never the service's keys
// or secrets.
const CHILD_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z]+|TZ|FONTCONFIG_[A-Z]+|XDG_[A-Z_]+|SYSTEMROOT|WINDIR)$/;
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => CHILD_ENV.test(name)));
const run = (file, args) => execFileAsync(file, args, { env: childEnv(), maxBuffer: 16 * 1024 * 1024 });
const ffmpeg = (args) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UI_FONT = "'Avenir Next', 'Nunito Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
// The story pages and the page around the card: ivory, near-black ink, one
// acid yellow-green for actions (the web app's palette), system type only
// (card pages load nothing from outside themselves).
const SANS = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, 'JetBrains Mono', Consolas, monospace";
const IVORY = '#F5F4EE';
const INK = '#141413';
const ACID = '#DFFF38';

const FPS = 24;
const LOOP_SECONDS = 16; // ad.mp4 repeats the orbit to about this long
const MUSIC_LUFS = -16; // music models deliver anything from -30 to -10 LUFS
const FLIP_FRAMES = 8; // frames per half of the card flip
const FLIP_HALF = FLIP_FRAMES / FPS;
const FADE = 0.25; // reveal steps within a page
const SLIDE = 0.45; // turning to the next page
const HOLDS = { you: 0.8, why: 1.0, catalogue: 1.1, fuse: 1.8 }; // seconds per reveal step
const LAST_HOLD = 0.7; // extra time on each page's final step
const BACKDROP = '0x0E0D0C'; // seen around the card while it flips

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const madeFor = (name) => (name ? `Made for ${name}` : 'Made for an audience of one');
const px = (n) => `${Math.round(n * 10) / 10}px`;
const nameScale = (name, sizes) => (name.length > 30 ? sizes[2] : name.length > 18 ? sizes[1] : sizes[0]);

// Front of the card: only the era line and product name over the orbit.
// Rendered pages load nothing from outside themselves, even if some text ever
// slipped past the escaping: Chrome runs them from file:// inside the enclave.
const RENDER_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`;

export function frontOverlayHtml(concept, { width, height }) {
  const u = width / 100;
  return `<!doctype html>
<html><head><meta charset="utf-8">${RENDER_CSP}<style>
html,body{margin:0;background:transparent;overflow:hidden}
.frame{position:relative;width:${width}px;height:${height}px;overflow:hidden;color:#fff;text-align:center}
.scrim{position:absolute;inset:0 0 auto;height:${px(height * 0.28)};background:linear-gradient(rgba(0,0,0,.6),rgba(0,0,0,0))}
.scrim.low{inset:auto 0 0;height:${px(height * 0.12)};background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.45))}
.top{position:absolute;left:${px(u * 7)};right:${px(u * 7)};top:${px(height * 0.045)}}
.era{font:600 ${px(u * 2.5)}/1.35 ${UI_FONT};letter-spacing:.3em;text-transform:uppercase;opacity:.86}
.name{font-family:${TYPEFACES[concept.typeface]};font-size:${px(u * nameScale(concept.product_name, [10.5, 8.6, 7]))};line-height:1.02;margin-top:${px(u * 2)};text-wrap:balance;text-shadow:0 0 ${px(u * 3)} rgba(0,0,0,.5)}
.mark{position:absolute;left:0;right:0;bottom:${px(height * 0.028)};font:700 ${px(u * 3.6)} ${UI_FONT};letter-spacing:.32em;text-indent:.32em;text-shadow:0 0 ${px(u * 2)} rgba(0,0,0,.65)}
.mark span{color:${ACID}}
</style></head><body><div class="frame">
<div class="scrim"></div><div class="scrim low"></div>
<div class="top"><div class="era">${esc(concept.era.replace(/,\s+/g, ' · '))}</div><div class="name">${esc(concept.product_name)}</div></div>
<div class="mark">ZK<span>ADS</span></div>
</div></body></html>
`;
}

// The pages behind the front, in order; pages whose details are missing are skipped.
const BADGE_SOURCES = { zktls: 'proved with zkTLS', fixture: 'test proof, not real', logs: 'from their own logs' };

export function storyPages(concept) {
  return ['you', 'why', 'catalogue', 'fuse'].filter((page) => (page === 'you' ? concept.archetype : page === 'catalogue' ? concept.catalogue?.length || concept.sponsored : true));
}

// The small heading over each page.
const PAGE_LABELS = { you: 'You, decoded', why: 'Why it’s yours', catalogue: 'Also made for you', fuse: 'Make one together' };
const count = (n) => String(n).padStart(2, '0');

// One page's HTML. Blocks appear one reveal step at a time in the video;
// later steps stay in the layout (hidden) so nothing shifts as they appear.
// Interactive pages get real buttons (links into the web app, for a hosted
// card: `links`); video frames get look-alike labels. `at` ([n, of]) puts
// the page's place in the story in its corner, for the video.
export function pageHtml(page, concept, { name, step = Infinity, interactive = true, links = null, at: place = null, matchable = false } = {}) {
  const at = (i) => (i > step ? ' later' : '');
  const action = (label, attrs, extra = '', href = null) =>
    !interactive ? `<span class="chip${extra}">${label}</span>` : href ? `<a class="chip${extra}" href="${esc(href)}">${label}</a>` : `<button class="chip${extra}" type="button" ${attrs}>${label}</button>`;
  const brand = `<div class="brand"><span>${place ? `${count(place[0])} / ${count(place[1])}` : ''}</span><b>ZK<i>ADS</i></b></div>`;
  if (page === 'you') {
    const blocks = [
      `<div class="block"><div class="label">${PAGE_LABELS.you}${name ? ` · for ${esc(name)}` : ''}</div><h2 class="title">${esc(concept.archetype)}</h2>${concept.reading ? `<p class="reading">${esc(concept.reading)}</p>` : ''}</div>`,
      concept.stat_value && `<div class="tile stat"><b${concept.stat_value.length > 5 ? ' class="long"' : ''}>${esc(concept.stat_value)}</b><span>${esc(concept.stat_label)}</span></div>`,
      // A usage badge: proved with zkTLS, or read from the person's own logs (hosted cards only).
      concept.badge && `<div class="tile stat seal"><b${concept.badge.value.length > 5 ? ' class="long"' : ''}>${esc(concept.badge.value)}</b><span>${esc(concept.badge.label)}<em>${BADGE_SOURCES[concept.badge.source] ?? BADGE_SOURCES.logs}</em></span></div>`,
      concept.rabbit_hole && `<div class="tile"><div class="label">Deepest rabbit hole</div><p class="big">${esc(concept.rabbit_hole)}</p></div>`,
      concept.era_match && `<div class="block"><div class="label">In ${esc(concept.era)}, you'd have been</div><p class="era">${esc(concept.era_match)}</p></div>`,
    ].filter(Boolean);
    return {
      steps: blocks.length,
      html: `<article class="page" data-page="you">${brand}${blocks.map((b, i) => `<div class="step${at(i)}">${b}</div>`).join('\n')}</article>`,
    };
  }
  if (page === 'why') {
    const reasons = concept.reasons
      .map((r, i) => `<li class="${at(i).trim()}"><span class="n">${i + 1}</span><div><p class="trait">${esc(r.you)}</p>${r.so ? `<p class="so">→ so ${esc(r.so)}</p>` : ''}</div></li>`)
      .join('');
    const last = concept.reasons.length;
    return {
      steps: last + 1,
      html: `<article class="page" data-page="why">${brand}
<div class="block"><div class="label">${PAGE_LABELS.why}</div><ol class="reasons">${reasons}</ol></div>
<div class="block${at(last)}"><div class="label">Drawn after</div><p class="artist">${esc(concept.artist)}</p>${concept.artist_reason ? `<p class="because">${esc(concept.artist_reason)}</p>` : ''}</div>
<div class="foot${at(last)}">${esc(concept.product_name)} · ${esc(concept.era)}</div>
</article>`,
    };
  }
  if (page === 'catalogue') {
    const catalogue = concept.catalogue ?? [];
    const items = catalogue.map((item, i) => `<div class="item${at(i)}"><div class="label">${esc(item.era)}</div><p class="item-name">${esc(item.name)}</p><p class="teaser">${esc(item.teaser)}</p>${action('Make this one', `data-idea="${i}"`, ' ghost', links?.idea(i))}</div>`);
    // A sponsored slot a brand won in the enclave's sealed auction (hosted cards only).
    const sponsor = concept.sponsored;
    if (sponsor) {
      const earned = sponsor.credits ? ` · you earned ${sponsor.credits} credits` : '';
      items.push(`<div class="item sponsored${at(catalogue.length)}"><div class="label">Sponsored · ${esc(sponsor.brand)}${earned}</div><p class="item-name">${esc(sponsor.name)}</p><p class="teaser">${esc(sponsor.teaser)}</p></div>`);
    }
    return {
      steps: items.length,
      html: `<article class="page" data-page="catalogue">${brand}
<div class="block"><div class="label">${PAGE_LABELS.catalogue}</div></div>
${items.join('\n')}
${catalogue.length ? `<p class="small${at(items.length - 1)}">${interactive ? 'Tap one to make its ad.' : 'Ask me to make one.'}</p>` : ''}
</article>`,
    };
  }
  // Finding a match needs the hosted app, so only a hosted card offers it (on
  // the page, or as a label in its video: `matchable`).
  const match = !interactive ? (matchable ? action('Find a match', '', ' ghost') : '') : links?.match ? action('Find a match', '', ' ghost', links.match) : '';
  return {
    steps: 1,
    html: `<article class="page" data-page="fuse">${brand}
<div class="block"><div class="label">${PAGE_LABELS.fuse}</div><h2 class="title">Two ways of thinking. One custom invention.</h2>
<p class="reading">Invite a friend. Make a shared 1/1.</p></div>
<div class="choices">${action('Invite a friend', 'data-invite', ' big-chip', links?.invite)}${match}</div>
<p class="small">${!interactive ? 'Ask me for an invite.' : links?.fictional ? 'This is an example: make your own card first, then invite a friend from it.' : links ? 'Your friend gets a short invite to give their assistant; theirs and yours stay private.' : 'For now this copies an invite your friend pastes into their own Claude. In the app it becomes a link.'}</p>
</article>`,
  };
}

// Styles for the back of the card, sized in container units (cqw) so the
// same page looks identical on a phone, on the share page and in the video.
export function sheetCss(concept) {
  const display = TYPEFACES[concept.typeface];
  // Every card's pages share the palette; the card's own typeface and accent
  // (on the reason numbers) keep its era.
  return `.sheet,.sheet *{box-sizing:border-box}
.sheet{container-type:inline-size;overflow:hidden;font-family:${SANS};background:${IVORY};color:${INK};--ink:${INK};--soft:#55544D;--rule:rgba(20,20,19,.22);--accent:${concept.accent_color};--display:${display}}
.sheet::before{content:"";position:absolute;inset:3.4cqw;border:0.25cqw solid var(--ink);pointer-events:none}
.progress{position:absolute;top:1.4cqw;left:6cqw;right:6cqw;display:flex;gap:1.2cqw;z-index:2}
.progress i{flex:1;height:0.5cqw;background:var(--rule)}
.progress i.on{background:var(--ink)}
.page{position:absolute;inset:0;padding:12cqw 8cqw 7cqw;display:flex;flex-direction:column;justify-content:space-evenly;text-align:left;overflow-wrap:anywhere;overflow:hidden}
.later{visibility:hidden}
.brand{position:absolute;top:5.8cqw;left:8cqw;right:8cqw;display:flex;justify-content:space-between;align-items:center;font:500 calc(2.8cqw*var(--fit,1)) ${MONO};letter-spacing:.12em;color:var(--soft)}
.brand b{font:700 calc(3.6cqw*var(--fit,1)) ${SANS};letter-spacing:.24em;color:var(--ink)}
.brand b i{font-style:normal;background:${ACID};padding:0 .3em 0 .1em;margin-left:.05em}
.label{font:500 calc(3cqw*var(--fit,1))/1.35 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:var(--soft)}
.title{margin:1.6cqw 0 0;font:400 calc(9.2cqw*var(--fit,1))/1.02 var(--display);letter-spacing:-.01em;text-wrap:balance}
.reading{margin:2.2cqw 0 0;max-width:96%;font:400 calc(4.9cqw*var(--fit,1))/1.32 ${SANS};color:var(--soft);text-wrap:pretty}
.tile{padding:3cqw 1.2cqw 0 0;border-top:0.25cqw solid var(--ink)}
.stat{display:flex;flex-wrap:wrap;align-items:center;gap:1.6cqw 3.4cqw;text-align:left}
.stat span{min-width:0;flex:1 1 30%}
.stat b{flex:none;white-space:nowrap;overflow-wrap:normal;font:400 calc(12cqw*var(--fit,1))/.9 var(--display)}
.stat b.long{font-size:calc(8.6cqw*var(--fit,1))}
.stat span{font-size:calc(4.6cqw*var(--fit,1));line-height:1.3}
.big{margin:1.4cqw 0 0;font:400 calc(5.8cqw*var(--fit,1))/1.22 ${SANS};text-wrap:pretty}
.era{margin:1.4cqw 0 0;font:400 calc(5.8cqw*var(--fit,1))/1.2 var(--display);text-wrap:balance}
.reasons{list-style:none;margin:2.6cqw 0 0;padding:0;display:flex;flex-direction:column;gap:3.4cqw}
.reasons li{display:flex;gap:3cqw;align-items:flex-start}
.n{flex:none;width:calc(7.6cqw*var(--fit,1));height:calc(7.6cqw*var(--fit,1));border-radius:50%;display:grid;place-items:center;background:var(--accent);color:var(--ink);border:0.25cqw solid var(--ink);font:600 calc(3.4cqw*var(--fit,1))/1 ${MONO}}
.trait{margin:0;font-size:calc(5cqw*var(--fit,1));line-height:1.25;font-weight:600}
.so{margin:.8cqw 0 0;font:400 calc(4.7cqw*var(--fit,1))/1.28 ${SANS};color:var(--soft)}
.artist{margin:1.2cqw 0 0;font:400 calc(6cqw*var(--fit,1))/1.1 var(--display)}
.because{margin:.8cqw 0 0;font:400 calc(4.5cqw*var(--fit,1))/1.32 ${SANS};color:var(--soft)}
.foot{border-top:0.25cqw solid var(--ink);padding-top:2.4cqw;font:500 calc(3.3cqw*var(--fit,1))/1.35 ${MONO};letter-spacing:.06em;text-transform:uppercase}
.item{padding:3cqw 0 0;border-top:0.25cqw solid var(--ink)}
.item.sponsored{border-top-style:dashed}
.seal{border-top-width:0.7cqw}
.seal em{display:block;font:500 calc(3.1cqw*var(--fit,1))/1.3 ${MONO};letter-spacing:.12em;text-transform:uppercase;font-style:normal;color:var(--soft);margin-top:.8cqw}
.item-name{margin:1cqw 0 0;font:400 calc(7cqw*var(--fit,1))/1.05 var(--display);text-wrap:balance}
.teaser{margin:1cqw 0 2.2cqw;font:400 calc(4.7cqw*var(--fit,1))/1.3 ${SANS};color:var(--soft)}
.chip{display:inline-block;text-decoration:none;border:0.25cqw solid ${ACID};border-radius:0.6cqw;padding:2cqw 4.4cqw;background:${ACID};color:var(--ink);font:500 calc(4.2cqw*var(--fit,1)) ${SANS};cursor:pointer}
.chip.ghost{background:transparent;border-color:var(--ink)}
.choices{display:flex;flex-wrap:wrap;align-items:center;gap:2.4cqw}
.big-chip{padding:3cqw 7cqw;font-size:calc(4.8cqw*var(--fit,1))}
.small{margin:0;font-size:calc(3.8cqw*var(--fit,1));line-height:1.4;color:var(--soft)}`;
}

// Shrinks each page's type a step at a time until its blocks fit the card.
// Sizes are in container units, so a fit found at one size holds at all sizes.
export const FIT_SCRIPT = `<script>
// Shrinks a page's text (--fit) only while something really sticks out of
// the page's padding (into the frame line), or out of a stat tile. Layout
// offsets are used, so the card's 3D flip cannot skew them, and a shrink that
// does not reduce the overflow is dropped. Pages are fitted again once fonts
// and the page have loaded, on resize, and when the card is turned over, so a
// measurement taken too early never sticks.
window.zkadsFit = () => {
  zkadsFit.width = document.querySelector('.page')?.clientWidth;
  for (const page of document.querySelectorAll('.page')) {
    page.style.removeProperty('--fit');
    // Inline text is measured through its block: a wrapped inline box's offsets span its lines.
    const els = [...page.querySelectorAll(':scope > :not(.brand), :scope > :not(.brand) *')].filter((el) => getComputedStyle(el).display !== 'inline');
    const beyond = (el, left, right, bottom) => (el.offsetWidth > 0 ? Math.max(left - el.offsetLeft, el.offsetLeft + el.offsetWidth - right, el.offsetTop + el.offsetHeight - bottom) : 0);
    // How far anything sticks out, in pixels; offsets are whole pixels, hence the slack.
    const excess = () => {
      const ps = getComputedStyle(page);
      let most = Math.max(0, ...els.map((el) => beyond(el, parseFloat(ps.paddingLeft), page.clientWidth - parseFloat(ps.paddingRight), page.clientHeight - parseFloat(ps.paddingBottom))));
      for (const tile of page.querySelectorAll('.stat')) {
        const ts = getComputedStyle(tile);
        const inside = tile.offsetLeft + tile.clientLeft;
        for (const child of tile.children) most = Math.max(most, beyond(child, inside + parseFloat(ts.paddingLeft), inside + tile.clientWidth - parseFloat(ts.paddingRight), Infinity));
      }
      return most > 3 ? most : 0;
    };
    const before = excess();
    let fit = 1;
    while (fit > 0.55 && excess()) page.style.setProperty('--fit', (fit = Math.round((fit - 0.04) * 100) / 100));
    if (fit < 1 && excess() >= before) page.style.removeProperty('--fit');
  }
};
zkadsFit();
document.fonts?.ready.then(() => zkadsFit());
addEventListener('load', () => zkadsFit());
// Only a change of width can change the fit (phones resize the page as their toolbars hide).
let refit = false;
addEventListener('resize', () => {
  if (refit || document.querySelector('.page')?.clientWidth === zkadsFit.width) return;
  refit = true;
  requestAnimationFrame(() => ((refit = false), zkadsFit()));
});
</script>`;

// A standalone document showing one page at one reveal step, for the video.
export function frameHtml(concept, { width, height, name, pages, index, step, matchable = false }) {
  // The front (the orbit) is the story's first page.
  const { html } = pageHtml(pages[index], concept, { name, step, interactive: false, at: [index + 2, pages.length + 1], matchable });
  return `<!doctype html>
<html><head><meta charset="utf-8">${RENDER_CSP}<style>
html,body{margin:0;background:#000;overflow:hidden}
${sheetCss(concept)}
.sheet{position:relative;width:${width}px;height:${height}px}
</style></head><body><div class="sheet">
<div class="progress">${pages.map((_, i) => `<i${i <= index ? ' class="on"' : ''}></i>`).join('')}</div>
${html}
</div>${FIT_SCRIPT}</body></html>
`;
}

// The reveal steps of every page, in order, with how long each stays up.
export function storySteps(concept) {
  return storyPages(concept).flatMap((page, index) => {
    const { steps } = pageHtml(page, concept);
    return Array.from({ length: steps }, (_, step) => ({ page, index, step, hold: HOLDS[page] + (step === steps - 1 ? LAST_HOLD : 0) }));
  });
}

// Where everything sits in story.mp4: the orbit, a flip, each reveal step
// (fades within a page, slides between pages), and a flip back to the
// orbit's first frame so the video loops.
export function storyTimeline(orbitSeconds, steps) {
  if (steps.length < 2) throw new Error('A story needs at least two reveal steps.');
  const transitions = steps.slice(1).map((s) => (s.step === 0 ? { type: 'slideleft', seconds: SLIDE } : { type: 'fade', seconds: FADE }));
  const durations = steps.map((s, i) => (i > 0 ? transitions[i - 1].seconds : 0) + s.hold + (i < steps.length - 1 ? transitions[i].seconds : 0));
  const offsets = [];
  let pages = durations[0];
  for (let i = 1; i < durations.length; i++) {
    offsets.push(pages - transitions[i - 1].seconds);
    pages += durations[i] - transitions[i - 1].seconds;
  }
  const flips = [orbitSeconds - FLIP_HALF, orbitSeconds + FLIP_HALF + pages];
  return { durations, offsets, transitions, pages, flips, total: flips[1] + 2 * FLIP_HALF };
}

export function storyLength(concept, orbitSeconds) {
  return storyTimeline(orbitSeconds, storySteps(concept)).total;
}

// The orbit already ends where it starts, so whole loops stay seamless.
export function loopLength(orbitSeconds) {
  const loops = Math.max(1, Math.round(LOOP_SECONDS / orbitSeconds));
  return { loops, total: loops * orbitSeconds };
}

function musicChain(input, { gainDb, total, musicSeconds }) {
  const fadeAt = Math.max(0, Math.min(total, musicSeconds) - 1.2);
  return `[${input}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${gainDb.toFixed(1)}dB,apad=whole_dur=${total},atrim=end=${total},afade=t=in:d=0.4,afade=t=out:st=${fadeAt}:d=1.2`;
}

const encode = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

// ad.mp4: the orbit looped with the type layer on top and the music bed
// (`musicLoop`: a short bed, such as the orbit's own soundtrack, repeats).
export function loopArgs({ orbit, front, music, musicGainDb = 0, musicSeconds = Infinity, musicLoop = false, width, height, orbitSeconds, out }) {
  const { loops, total } = loopLength(orbitSeconds);
  const inputs = ['-stream_loop', String(loops - 1), '-i', orbit, '-loop', '1', '-i', front];
  if (music) inputs.push(...(musicLoop ? ['-stream_loop', '-1'] : []), '-i', music);
  const graph = [
    `[0:v]fps=${FPS},scale=${width}:${height},setsar=1,format=yuv420p[orbit]`,
    `[1:v]scale=${width}:${height},format=rgba[type]`,
    `[orbit][type]overlay=0:0:shortest=1,format=yuv420p[v]`,
  ];
  if (music) graph.push(`${musicChain(2, { gainDb: musicGainDb, total, musicSeconds })},alimiter=limit=0.95:level=0[a]`);
  return [...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', ...(music ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []), '-t', String(total), ...encode, out];
}

// Perspective corners for one half of the flip: the card narrows to its edge
// ("out") or swings open from it ("in"), with the far edge foreshortened.
function flipFilter(direction) {
  // perspective's `in` counts frames from 1, so q runs 1/N … 1 and never overshoots.
  const q = `in/${FLIP_FRAMES}`;
  const open = `sin(PI/2*${q})`;
  const close = `cos(PI/2*${q})`;
  const width = direction === 'out' ? close : open;
  const lean = `H*0.06*${direction === 'out' ? open : close}`;
  const left = `W/2-W/2*${width}`;
  const right = `W/2+W/2*${width}`;
  const c = direction === 'out'
    ? { x0: left, y0: '0', x1: right, y1: lean, x2: left, y2: 'H', x3: right, y3: `H-${lean}` }
    : { x0: left, y0: lean, x1: right, y1: '0', x2: left, y2: `H-${lean}`, x3: right, y3: 'H' };
  const corners = Object.entries(c).map(([k, v]) => `${k}='${v}'`).join(':');
  // The 3px border becomes the backdrop that fills around the turning card.
  return `drawbox=x=0:y=0:w=iw:h=ih:color=${BACKDROP}:t=3,perspective=${corners}:sense=destination:eval=frame,trim=end_frame=${FLIP_FRAMES},setpts=PTS-STARTPTS`;
}

// story.mp4: one orbit, a flip, the page frames, a flip back to the orbit's
// first frame. Inputs: orbit, front type layer, one PNG per reveal step,
// optional music; the flip swish is synthesized pink noise.
export function storyArgs({ orbit, front, frames, steps, music, musicGainDb = 0, musicSeconds = Infinity, musicLoop = false, width, height, orbitSeconds, out }) {
  if (frames.length !== steps.length) throw new Error('One frame is needed per reveal step.');
  const t = storyTimeline(orbitSeconds, steps);
  const norm = `fps=${FPS},scale=${width}:${height},setsar=1,format=yuv420p`;
  const inputs = ['-i', orbit, '-loop', '1', '-i', front];
  for (const frame of frames) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(Math.ceil(t.total)), '-i', frame);
  const first = 2;
  const last = first + frames.length - 1;
  const musicInput = last + 1;
  if (music) inputs.push(...(musicLoop ? ['-stream_loop', '-1'] : []), '-i', music);
  inputs.push('-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.6:sample_rate=48000:duration=0.7');
  const swish = music ? musicInput + 1 : musicInput;

  const graph = [
    `[0:v]${norm}[orbit]`,
    `[1:v]scale=${width}:${height},format=rgba[type]`,
    `[orbit][type]overlay=0:0:shortest=1,${norm},split=3[f1][f2][f3]`,
    `[f1]trim=end=${orbitSeconds - FLIP_HALF},setpts=PTS-STARTPTS[s1]`,
    `[f2]trim=start=${orbitSeconds - FLIP_HALF},setpts=PTS-STARTPTS,${flipFilter('out')},${norm}[s2]`,
    `[f3]trim=end_frame=1,loop=loop=${FLIP_FRAMES}:size=1:start=0,setpts=N/${FPS}/TB,${flipFilter('in')},${norm}[s6]`,
    `[${first}:v]${norm},split=2[p0][p0flip]`,
    `[p0flip]${flipFilter('in')},${norm}[s3]`,
    `[p0]trim=duration=${t.durations[0]},setpts=PTS-STARTPTS,fps=${FPS}[r0]`,
  ];
  // xfade needs a declared constant frame rate, which setpts clears on
  // ffmpeg 7 (the render container's), so each page restates it.
  for (let i = 1; i < frames.length - 1; i++) graph.push(`[${first + i}:v]${norm},trim=duration=${t.durations[i]},setpts=PTS-STARTPTS,fps=${FPS}[r${i}]`);
  const end = frames.length - 1;
  graph.push(`[${last}:v]${norm},split=2[p${end}][p${end}flip]`, `[p${end}]trim=duration=${t.durations[end]},setpts=PTS-STARTPTS,fps=${FPS}[r${end}]`, `[p${end}flip]${flipFilter('out')},${norm}[s5]`);
  let chain = 'r0';
  t.transitions.forEach((transition, i) => {
    const output = i === t.transitions.length - 1 ? 'pages' : `x${i + 1}`;
    graph.push(`[${chain}][r${i + 1}]xfade=transition=${transition.type}:duration=${transition.seconds}:offset=${t.offsets[i]}[${output}]`);
    chain = output;
  });
  graph.push(
    `[pages]${norm}[s4]`,
    `[s1][s2][s3][s4][s5][s6]concat=n=6:v=1:a=0,format=yuv420p[v]`,
    `[${swish}:a]highpass=f=500,lowpass=f=6000,afade=t=in:d=0.12,afade=t=out:st=0.2:d=0.5,volume=0.5,aformat=channel_layouts=stereo,asplit=2[w1][w2]`,
    ...t.flips.map((at, i) => `[w${i + 1}]adelay=delays=${Math.round(at * 1000)}:all=1[d${i + 1}]`),
  );
  if (music) {
    graph.push(`${musicChain(musicInput, { gainDb: musicGainDb, total: t.total, musicSeconds })}[m]`, `[m][d1][d2]amix=inputs=3:normalize=0:duration=first,alimiter=limit=0.95:level=0[a]`);
  } else {
    graph.push(`[d1][d2]amix=inputs=2:normalize=0,apad=whole_dur=${t.total},atrim=end=${t.total}[a]`);
  }
  return [...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(t.total), ...encode, '-c:a', 'aac', '-b:a', '192k', out];
}

// JSON for an inline <script type="application/json"> block, unable to close it early.
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// What the next-page button says, by the page it turns to.
const NEXT_LABELS = { you: 'You, decoded', why: 'Why this object?', catalogue: 'Your catalogue', fuse: 'Make one together' };
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

export function sharePageHtml(concept, { video, story, poster, width, height, name, run, prompts = {}, site = null, card = null, ownSound = false, fictional = false }) {
  const usd = [run.concept?.usd, run.image?.usd, run.video?.usd, run.music?.usd].filter((n) => typeof n === 'number');
  const total = usd.length ? `≈ $${usd.reduce((a, b) => a + b, 0).toFixed(2)}` : '';
  const steps = [fictional ? 'a written concept' : run.concept?.model, run.image?.model, run.video?.model && `${run.video.model} · 360° orbit${ownSound ? ' and sound' : ''}`, run.music?.model && `${run.music.model} · music`].filter(Boolean);
  const created = run.created ? new Date(run.created).toISOString().slice(0, 10) : '';
  let provenance;
  if (run.concept?.kind === 'catalogue') {
    provenance = `Written by ${run.concept.model ?? 'a text model'} through Venice from an item in your earlier card’s catalogue; no history was read.`;
  } else if (run.concept?.source === 'enclave') {
    const where = run.concept.tee ? 'inside Phala’s GPU TEE' : 'in a local test enclave (not attested)';
    // A fusion whose summaries were all withdrawn before it ran was written from the cards alone.
    const from = run.concept.summaries === 0 ? 'from the cards alone' : run.concept.summaries === 1 ? 'from a sealed summary that ZKAds never saw' : 'from sealed summaries that ZKAds never saw';
    provenance = `Written by ${run.concept.model ?? 'a confidential model'} ${where} ${from}${run.concept.receipt ? ` (receipt ${run.concept.receipt})` : ''}.`;
  } else if (run.concept?.source === 'import') {
    provenance = fictional
      ? 'A fictional example: ZK Ads wrote this concept for an imagined maker, so no one’s history was read. Its media was generated with the command-line tool, outside a TEE.'
      : 'Your own assistant read your history and wrote this concept; ZKAds only received the finished concept.';
  } else {
    provenance = `Made with the command-line tool, outside a TEE. The history was processed by ${run.concept?.model ?? 'a text model'} through Venice (${run.concept?.privacy ?? 'unknown'} inference).`;
  }
  // Cards rendered inside a Phala CVM carry a TDX quote over their files' hashes.
  const attestation = run.attested ? '<p><a href="attestation.json">Rendered inside a Phala TEE · attestation</a></p>' : '';
  const pages = storyPages(concept);
  const front = video
    ? `<video src="${esc(video)}" poster="${esc(poster)}" autoplay muted loop playsinline></video>`
    : `<img src="${esc(poster)}" alt="${esc(concept.product_name)}">`;
  const data = { caption: concept.share_caption, ideas: prompts.ideas ?? [], invite: prompts.invite ?? '', site: /^https?:\/\/[^\s"'<>`$]+$/.test(site ?? '') ? site.replace(/\/+$/, '') : null, next: pages.map((page) => NEXT_LABELS[page]) };
  // A hosted card's buttons open the web app, which makes the card or the
  // invite; the fictional example's lead to the app, to make one's own.
  const hosted = data.site && /^[a-z2-7]{20}$/.test(card ?? '');
  const links = fictional && data.site
    ? { idea: () => `${data.site}/`, invite: `${data.site}/`, match: `${data.site}/`, fictional: true }
    : hosted
      ? { idea: (i) => `${data.site}/catalogue?card=${card}&item=${i}`, invite: `${data.site}/invite?card=${card}`, match: `${data.site}/match?card=${card}` }
      : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(concept.product_name)} · ZK Ads</title>
<style>
:root{color-scheme:light;--bg:${IVORY};--ink:${INK};--soft:#3d3c37;--muted:#64635c;--hair:#d8d6cc;--accent:${ACID};--accent-down:#cdee1f;--sans:${SANS};--mono:${MONO}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
[hidden]{display:none!important}
header,main,footer{max-width:560px;margin:0 auto;padding-left:24px;padding-right:24px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:72px;border-bottom:1px solid var(--ink)}
.brandmark{display:inline-block;line-height:0;color:var(--ink);text-decoration:none}
.brandmark img{height:30px;width:auto}
.brandmark.text{line-height:1;font-weight:800;letter-spacing:.2em;font-size:20px}
.brandmark.text span{background:var(--accent);padding:0 .2em}
.tag{font:500 12px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase}
main{padding-top:18px;padding-bottom:24px}
.count,.card,.controls,.cta{width:min(400px,100%);margin-left:auto;margin-right:auto}
.count{display:flex;align-items:center;gap:14px;margin-bottom:14px;font:500 13px/1 var(--mono);letter-spacing:.06em}
.bars{display:flex;gap:6px;flex:1}
.bars i{flex:1;height:2px;background:var(--hair)}
.bars i.on{background:var(--ink)}
.card{position:relative;aspect-ratio:${width}/${height};perspective:1800px;cursor:pointer;outline-offset:6px;user-select:none}
.inner{position:relative;width:100%;height:100%;transition:transform .7s cubic-bezier(.3,.7,.2,1);transform-style:preserve-3d}
.card.flipped .inner{transform:rotateY(180deg)}
.face{position:absolute;inset:0;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:1px solid var(--ink);box-shadow:0 18px 44px rgba(20,20,19,.16)}
.front{background:#000}
.front video,.front img{display:block;width:100%;height:100%;object-fit:cover}
.back{transform:rotateY(180deg)}
${sheetCss(concept)}
.back .progress{display:none}
.back .page{opacity:0;visibility:hidden;transition:opacity .35s}
.back .page.on{opacity:1;visibility:visible}
/* Arrows at the card's edges; they pulse until the card is first turned. */
.nav{position:absolute;top:50%;z-index:3;width:40px;height:40px;margin-top:-20px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;background:rgba(20,20,19,.62);color:#fff;cursor:pointer;opacity:.55;animation:nudge 2.4s ease-in-out infinite;transition:opacity .2s}
.nav svg{width:20px;height:20px}
.nav.next{right:-18px}
.nav.prev{left:-18px}
.card:not(.flipped) .nav.prev{display:none}
.card.seen .nav{animation:none}
.nav:hover,.nav:focus-visible{opacity:1;animation:none}
@keyframes nudge{50%{opacity:.15}}
.controls{display:flex;align-items:center;justify-content:center;gap:4px;margin-top:16px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink)}
.ctl{display:inline-flex;align-items:center;gap:8px;min-height:46px;padding:0 12px;border:0;background:none;color:var(--ink);font:400 15px/1 var(--mono);cursor:pointer}
.ctl svg{width:22px;height:22px;flex:none}
.sep{width:1px;height:22px;background:var(--ink)}
#sound .on,#sound[aria-pressed="true"] .off{display:none}
#sound[aria-pressed="true"] .on{display:inline}
#spin[aria-pressed="false"]{color:var(--muted)}
.cta{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:0 18px;border:1px solid var(--ink);border-radius:3px;background:transparent;color:var(--ink);font:400 16px/1.2 var(--sans);text-decoration:none;cursor:pointer}
.btn:hover{background:rgba(20,20,19,.05)}
.btn.primary{min-height:56px;background:var(--accent);border-color:var(--accent);font-size:18px}
.btn.primary:hover{background:var(--accent-down);border-color:var(--accent-down)}
.btn svg{width:20px;height:20px}
.btn.quiet{border-color:transparent;min-height:44px;justify-content:flex-start;padding:0 2px}
.actions{display:flex;gap:10px}
.actions>*{flex:1}
.menu{position:relative}
.menu summary{list-style:none;width:100%}
.menu summary::-webkit-details-marker{display:none}
.menu .options{position:absolute;z-index:5;top:calc(100% + 6px);right:0;min-width:180px;padding:6px;background:var(--bg);border:1px solid var(--ink);border-radius:3px;box-shadow:0 18px 40px rgba(20,20,19,.14)}
.menu .options a{display:block;padding:10px 12px;color:var(--ink);text-decoration:none;font:400 15px var(--sans);white-space:nowrap}
.menu .options a:hover,.menu .options a:focus-visible{background:rgba(20,20,19,.06)}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(520px,calc(100% - 32px));background:var(--ink);color:var(--bg);border-radius:3px;padding:12px 16px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .25s}
.toast.on{opacity:1}
.copy{margin-top:32px;padding-top:20px;border-top:1px solid var(--ink)}
h3{font:500 12px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px}
.tagline{font-family:${TYPEFACES[concept.typeface]};font-size:22px;line-height:1.25;margin:0 0 10px}
.pitch{color:var(--soft);margin:0}
footer{border-top:1px solid var(--hair);color:var(--muted);font-size:13px;padding-top:18px;padding-bottom:48px}
footer p{margin:6px 0}
footer a{color:var(--soft);text-underline-offset:3px}
.details summary{display:inline-flex;align-items:center;gap:6px;min-height:44px;list-style:none;cursor:pointer;font:500 12px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.details summary::-webkit-details-marker{display:none}
.details .caret{letter-spacing:0;transition:transform .2s}
.details[open] .caret{transform:rotate(180deg)}
.details[open] summary{margin-bottom:8px}
.pipeline{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.pipeline span{padding:4px 10px;border:1px solid var(--hair);border-radius:3px;color:var(--soft)}
@media (prefers-reduced-motion:reduce){.inner,.back .page,.details .caret{transition:none}.nav{animation:none}}
</style>
</head>
<body>
<header>${data.site ? `<a class="brandmark" href="${esc(data.site)}/"><img src="/logo.png" alt="ZK Ads" width="101" height="30"></a>` : '<div class="brandmark text">ZK<span>ADS</span></div>'}${fictional ? '<span class="tag">Fictional example</span>' : ''}</header>
<main>
<div class="count" aria-hidden="true"><span id="count">01 / ${count(pages.length + 1)}</span><span class="bars">${['front', ...pages].map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</span></div>
<div class="card" id="card" tabindex="0" role="group" aria-roledescription="story card" aria-label="${esc(concept.product_name)}. Press the right arrow for the next page.">
<div class="inner">
<section class="face front">${front}</section>
<section class="face back sheet" aria-live="polite">
<div class="progress">${pages.map(() => '<i></i>').join('')}</div>
${pages.map((page) => pageHtml(page, concept, { name, links }).html).join('\n')}
</section>
</div>
<button class="nav prev" type="button" aria-label="Previous page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
<button class="nav next" type="button" aria-label="Next page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
</div>
${video ? `<div class="controls">
<button class="ctl" id="spin" type="button" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20.2 4v4.5h-4.5"/></svg>360°</button>
<span class="sep" aria-hidden="true"></span>
<button class="ctl" id="sound" type="button" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5h3.5l5-4v13l-5-4H3.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg><span class="off">Sound off</span><span class="on">Sound on</span></button>
</div>` : ''}
<div class="cta">
<button class="btn primary" id="next" type="button"><span>Flip to your story</span>${ARROW}</button>
<button class="btn quiet" id="back" type="button" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>Back</button>
<div class="actions">
<a class="btn" id="share" href="${esc(`https://twitter.com/intent/tweet?text=${encodeURIComponent(concept.share_caption)}`)}" target="_blank" rel="noopener">Share on X</a>
<details class="menu" id="downloads">
<summary class="btn">Download <span aria-hidden="true">▾</span></summary>
<div class="options">
${story ? `<a href="${esc(story)}" download>Story video</a>` : ''}
${video ? `<a href="${esc(video)}" download>360° loop</a>` : ''}
<a href="${esc(poster)}" download>Still image</a>
</div>
</details>
</div>
</div>
<section class="copy">
<h3>The pitch</h3>
<p class="tagline">${esc(concept.tagline)}</p>
<p class="pitch">${esc(concept.pitch)} <strong>${esc(concept.price)}.</strong></p>
</section>
</main>
<footer>
<details class="details">
<summary>Details <span class="caret" aria-hidden="true">▾</span></summary>
<div class="pipeline"><span>${fictional ? 'A fictional maker' : 'Chat history'}</span>${steps.map((s) => `→<span>${esc(s)}</span>`).join('')}</div>
<p>${esc(fictional ? 'Made for an imagined maker' : madeFor(name))} · style after ${esc(concept.artist)} · ${esc(concept.era)}${created ? ` · ${created}` : ''}${total ? ` · ${total}` : ''}</p>
<p>${esc(provenance)}</p>
${attestation}
</details>
</footer>
<div class="toast" id="toast" role="status"></div>
<script type="application/json" id="zkads-data">${inlineJson(data)}</script>
<script>
const data = JSON.parse(document.getElementById('zkads-data').textContent);
const card = document.getElementById('card');
const pages = [...card.querySelectorAll('.page')];
const bars = [...card.querySelectorAll('.progress i')];
const stops = [...document.querySelectorAll('.bars i')];
const counter = document.getElementById('count');
const nextButton = document.getElementById('next');
const backButton = document.getElementById('back');
const toast = document.getElementById('toast');
const pad = (n) => String(n).padStart(2, '0');
let at = -1; // -1 is the front; 0.. are the back pages

function show(next) {
  // A button on the page being left would keep focus while hidden; hand it
  // back to the card (the arrows stay, but "previous" hides on the front).
  const focused = document.activeElement;
  const stays = focused.matches('.nav.next') || (focused.matches('.nav.prev') && next >= 0);
  if (card.contains(focused) && focused !== card && !stays) card.focus({ preventScroll: true });
  card.classList.add('seen');
  // Turning the card over: fit its pages to the card as it is now.
  if (at < 0 && next >= 0) window.zkadsFit?.();
  at = next;
  card.classList.toggle('flipped', at >= 0);
  pages.forEach((page, i) => page.classList.toggle('on', i === at));
  bars.forEach((bar, i) => bar.classList.toggle('on', i <= at));
  stops.forEach((stop, i) => stop.classList.toggle('on', i <= at + 1));
  counter.textContent = pad(at + 2) + ' / ' + pad(pages.length + 1);
  nextButton.firstElementChild.textContent = at < 0 ? 'Flip to your story' : at + 1 < pages.length ? data.next[at + 1] : 'Back to the object';
  // Back hides on the front, so focus moves on to the main button.
  if (at < 0 && document.activeElement === backButton) nextButton.focus({ preventScroll: true });
  backButton.hidden = at < 0;
}
const step = (by) => show(at + by >= pages.length || at + by < -1 ? -1 : at + by);
const fromHash = Number((location.hash.match(/^#page-(\\d+)$/) || [])[1]);
if (fromHash >= 1 && fromHash <= pages.length) show(fromHash - 1);

card.addEventListener('click', (event) => {
  if (event.target.closest('button, a')) return;
  const box = card.getBoundingClientRect();
  step(at >= 0 && event.clientX - box.left < box.width * 0.3 ? -1 : 1);
});
card.querySelector('.nav.next').addEventListener('click', () => step(1));
card.querySelector('.nav.prev').addEventListener('click', () => step(-1));
nextButton.addEventListener('click', () => step(1));
backButton.addEventListener('click', () => step(-1));

card.addEventListener('keydown', (event) => {
  // On a button or link, Enter and Space press it; the arrows still turn the page.
  if (event.target.closest('button, a') && (event.key === 'Enter' || event.key === ' ')) return;
  if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); step(1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
});

let toastTimer;
async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast.textContent = message;
  } catch {
    toast.textContent = 'Copying is blocked here; try another browser.';
  }
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), 6000);
}
card.querySelectorAll('[data-idea]').forEach((button) => button.addEventListener('click', () =>
  copy(data.ideas[Number(button.dataset.idea)], data.site
    ? 'Prompt copied. Paste it into your assistant, then paste its reply at ' + data.site + '/make.'
    : 'Prompt copied. Paste it into your Claude, then run: npm run make -- --concept - (and paste its reply).')));
card.querySelectorAll('[data-invite]').forEach((button) => button.addEventListener('click', () =>
  copy(data.invite, data.site
    ? 'Invite copied. Send it to a friend: their assistant writes your shared item, which they make at ' + data.site + '/make.'
    : 'Invite copied. Send it to a friend to paste into their own Claude; its reply makes your shared item.')));
// Sharing posts the caption with a link to this card's own page.
if (/^https?:$/.test(location.protocol)) document.getElementById('share').href = 'https://twitter.com/intent/tweet?' + new URLSearchParams({ text: data.caption, url: location.origin + location.pathname });

// The download menu closes once a file is chosen, on a click elsewhere, or with Escape.
const downloads = document.getElementById('downloads');
downloads.addEventListener('click', (event) => {
  if (!event.target.closest('a')) return;
  downloads.open = false;
  downloads.querySelector('summary').focus();
});
document.addEventListener('click', (event) => { if (downloads.open && !downloads.contains(event.target)) downloads.open = false; });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !downloads.open) return;
  downloads.open = false;
  downloads.querySelector('summary').focus();
});

const video = card.querySelector('video');
const sound = document.getElementById('sound');
const spin = document.getElementById('spin');
if (video) {
  // The orbit turns until stopped; with reduced motion it waits to be started.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) video.pause();
  spin.setAttribute('aria-pressed', String(!still));
  spin.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener('play', () => spin.setAttribute('aria-pressed', 'true'));
  video.addEventListener('pause', () => spin.setAttribute('aria-pressed', 'false'));
  sound.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted) video.play().catch(() => {});
    sound.setAttribute('aria-pressed', String(!video.muted));
  });
}
</script>
${FIT_SCRIPT}
</body>
</html>
`;
}

export function findChrome(env = process.env) {
  const candidates = [
    env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path) => path && isExecutableFile(path)) ?? null;
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function hasFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
    await run('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function probe(path, stream, entries) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', entries, '-of', 'csv=p=0', path]);
  return stdout.trim();
}

export async function mediaSize(path) {
  const [width, height] = (await probe(path, 'v:0', 'stream=width,height')).split(',').map(Number);
  if (!width || !height) throw new Error(`Could not read the size of ${path}`);
  return { width, height };
}

// Length of one stream (v:0 or a:0); the container can be longer, e.g. when
// a generated video's audio track runs past its picture.
async function hasAudio(path) {
  return Boolean(await probe(path, 'a:0', 'stream=codec_type').catch(() => ''));
}

async function streamSeconds(path, stream) {
  const seconds = Number(await probe(path, stream, 'stream=duration')) || Number(await probe(path, stream, 'format=duration'));
  if (!seconds) throw new Error(`Could not read the length of ${path}`);
  return seconds;
}

// Integrated loudness in LUFS (ffmpeg's EBU R128 meter), or null if ffmpeg
// cannot measure it; the music
// is then mixed without a level correction rather than failing the card.
// framelog=verbose keeps the per-frame lines out of stderr on every ffmpeg
// version (older ones lack framelog=quiet).
export async function loudness(path) {
  try {
    const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'], { env: childEnv(), maxBuffer: 16 * 1024 * 1024 });
    const match = stderr.match(/I:\s+(-?[\d.]+) LUFS/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// Gain that brings the music to the target loudness, kept within ±20 dB.
export function musicGain(lufs) {
  return lufs == null || !Number.isFinite(lufs) ? 0 : Math.max(-20, Math.min(20, MUSIC_LUFS - lufs));
}

// Headless Chrome writes the screenshot but does not always exit afterwards,
// so wait for the file to stop growing, then close the browser.
export async function screenshotHtml({ chrome, htmlPath, pngPath, width, height, timeoutMs = 30_000 }) {
  rmSync(pngPath, { force: true });
  const profile = mkdtempSync(join(tmpdir(), 'zkads-chrome-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      `--user-data-dir=${profile}`,
      '--force-device-scale-factor=1',
      // Containers usually lack the user namespaces Chrome's sandbox needs and
      // give /dev/shm only 64 MB; the pages rendered here are our own.
      ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      '--default-background-color=00000000',
      `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: 'ignore', env: childEnv() },
  );
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  try {
    let lastSize = -1;
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
      await sleep(250);
      if (spawnError) throw new Error(`Could not start Chrome (${spawnError.message}).`);
      const size = existsSync(pngPath) ? statSync(pngPath).size : 0;
      if (size > 0 && size === lastSize) return;
      const ended = child.exitCode ?? child.signalCode;
      if (ended !== null && size === 0) throw new Error(`Chrome exited (${ended}) without a screenshot.`);
      lastSize = size;
    }
    throw new Error('Timed out waiting for the Chrome screenshot.');
  } finally {
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (!(await Promise.race([exited, sleep(3000)]))) child.kill('SIGKILL');
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp profile is harmless; the OS clears its temp folder.
    }
  }
}

// Renders HTML documents to PNGs a few browsers at a time.
async function screenshotAll(chrome, jobs, concurrency = 4) {
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      writeFileSync(job.htmlPath, job.html);
      await screenshotHtml({ chrome, ...job });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// `site` is the hosted app's address, for hosted cards' buttons; the CLI has
// none. `sponsor` is a sponsored catalogue item a brand won for this card;
// `badge` a usage stat proved with zkTLS or read from the person's logs.
// `fictional` marks the landing page's example (scripts/example.mjs).
export async function renderShare({ dir, concept: base, run: runInfo, name, log = console.log, site = null, card = null, sponsor = null, badge = null, fictional = false }) {
  const concept = { ...base, ...(sponsor ? { sponsored: sponsor } : {}), ...(badge ? { badge } : {}) };
  const heroPath = join(dir, 'hero.png');
  const orbitPath = join(dir, 'orbit.mp4');
  if (!existsSync(heroPath)) throw new Error('No hero.png yet; run the image step first.');
  const chrome = findChrome();
  if (!chrome || !(await hasFfmpeg())) throw new Error('The share step needs Google Chrome (or CHROME_PATH) and ffmpeg.');

  // A video made from an earlier hero.png would not match the new poster.
  // run.orbit records the hero behind orbit.mp4; older runs only have the job record.
  const madeFrom = runInfo.orbit?.hero_sha256 ?? (runInfo.video?.status === 'done' ? runInfo.video.hero_sha256 : undefined);
  const hasOrbit = existsSync(orbitPath) && (!madeFrom || madeFrom === digest(readFileSync(heroPath)));
  if (existsSync(orbitPath) && !hasOrbit) log('  orbit.mp4 was made from an earlier hero.png, so it is left out; run the orbit step again.');
  if (!hasOrbit) for (const stale of ['ad.mp4', 'story.mp4', 'front.mp4']) rmSync(join(dir, stale), { force: true });
  const musicFile = runInfo.music?.status === 'done' && runInfo.music.file && existsSync(join(dir, runInfo.music.file)) ? runInfo.music.file : null;
  const hero = await mediaSize(heroPath);
  const frame = hasOrbit ? await mediaSize(orbitPath) : hero;

  const layers = join(dir, 'layers');
  rmSync(layers, { recursive: true, force: true });
  mkdirSync(layers, { recursive: true });
  const shot = (id, html, size) => ({ html, htmlPath: join(layers, `${id}.html`), pngPath: join(layers, `${id}.png`), ...size });
  const pages = storyPages(concept);
  const steps = storySteps(concept);
  const jobs = [shot('front-hero', frontOverlayHtml(concept, hero), hero)];
  if (hasOrbit) {
    jobs.push(shot('front', frontOverlayHtml(concept, frame), frame));
    const matchable = Boolean(site && /^[a-z2-7]{20}$/.test(card ?? ''));
    steps.forEach((s, i) => jobs.push(shot(`page-${String(i).padStart(2, '0')}`, frameHtml(concept, { ...frame, name, pages, index: s.index, step: s.step, matchable }), frame)));
  }
  await screenshotAll(chrome, jobs);
  await ffmpeg(['-i', heroPath, '-i', join(layers, 'front-hero.png'), '-filter_complex', '[0:v][1:v]overlay=0:0', '-frames:v', '1', '-q:v', '2', join(dir, 'poster.jpg')]);

  let video = null;
  let story = null;
  let ownSound = false;
  if (hasOrbit) {
    const orbitSeconds = await streamSeconds(orbitPath, 'v:0');
    // A music bed if the card has one (made with a separate music model);
    // otherwise the orbit's own soundtrack, repeated under the whole story.
    // (run.orbit describes this orbit.mp4; older runs only have the finished job record.)
    const asked = runInfo.orbit?.sound ?? (runInfo.video?.status === 'done' ? runInfo.video.sound : false);
    const own = !musicFile && asked === true && (await hasAudio(orbitPath));
    ownSound = own;
    const music = musicFile ? join(dir, musicFile) : own ? orbitPath : null;
    const lufs = music ? await loudness(music) : null;
    if (music && lufs === null) log('  Could not measure the sound’s loudness, so it is mixed without a level correction.');
    const sound = !music ? {} : own ? { music, musicGainDb: musicGain(lufs), musicSeconds: Infinity, musicLoop: true } : { music, musicGainDb: musicGain(lufs), musicSeconds: await streamSeconds(music, 'a:0') };
    const storySeconds = storyTimeline(orbitSeconds, steps).total;
    if (music && sound.musicSeconds < storySeconds - 0.5) {
      log(`  The music (${sound.musicSeconds.toFixed(1)}s) is shorter than the story (${storySeconds.toFixed(1)}s); run the music step again for a longer bed.`);
    }
    const common = { orbit: orbitPath, front: join(layers, 'front.png'), ...sound, ...frame, orbitSeconds };
    await ffmpeg(loopArgs({ ...common, out: join(dir, 'ad.mp4') }));
    const frames = steps.map((_, i) => join(layers, `page-${String(i).padStart(2, '0')}.png`));
    await ffmpeg(storyArgs({ ...common, frames, steps, out: join(dir, 'story.mp4') }));
    video = 'ad.mp4';
    story = 'story.mp4';
  }

  // Ready-made prompts behind the page's buttons until the app can run them itself.
  const prompts = {
    ideas: (concept.catalogue ?? []).map((idea) => buildClaudePrompt({ idea })),
    invite: buildClaudePrompt({ friend: { ...concept, name } }),
  };
  writeFileSync(join(dir, 'index.html'), sharePageHtml(concept, { video, story, poster: 'poster.jpg', ...frame, name, run: runInfo, prompts, site, card, ownSound, fictional }));
  return { video, story, poster: 'poster.jpg', music: musicFile };
}
