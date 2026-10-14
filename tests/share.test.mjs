import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TYPEFACES, validateConcept } from '../lib/concept.mjs';
import { digest } from '../lib/media.mjs';
import {
  esc,
  findChrome,
  FIT_SCRIPT,
  frameHtml,
  frontOverlayHtml,
  hasFfmpeg,
  loopArgs,
  loopLength,
  loudness,
  musicGain,
  pageHtml,
  sheetCss,
  renderShare,
  screenshotHtml,
  sharePageHtml,
  storyArgs,
  storyLength,
  storyPages,
  storySteps,
  storyTimeline,
} from '../lib/share.mjs';
import { sampleConcept } from './fixtures.mjs';

const card = () => validateConcept(sampleConcept());
const hostile = () =>
  validateConcept({
    ...sampleConcept(),
    product_name: '<script>alert(1)</script>',
    tagline: '"><img src=x onerror=alert(2)>',
    archetype: '<b>Boss</b>',
    reasons: [{ you: "it's <b>you</b>", so: '<i>so</i>' }, { you: 'two', so: '' }],
    artist: 'A & B',
    era: '<i>era</i>',
    catalogue: [{ name: '<svg onload=x>', era: 'e', teaser: '</script>' }],
    share_caption: '</script><script>alert(3)</script>',
  });

test('escaping covers HTML-significant characters', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('the front keeps only the era line and the name, escaped', () => {
  const html = frontOverlayHtml(hostile(), { width: 768, height: 1344 });
  assert.doesNotMatch(html, /<script>|<img|<i>era/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<div class="era">&lt;i&gt;era&lt;\/i&gt;<\/div>/);
  assert.match(frontOverlayHtml(sampleConcept(), { width: 768, height: 1344 }), /<div class="era">Vienna · 1908<\/div>/, 'place and time, with no catalogue number');
  assert.match(frontOverlayHtml({ ...sampleConcept(), era: 'Arrakis, 10,191 AG' }, { width: 768, height: 1344 }), /<div class="era">Arrakis · 10,191 AG<\/div>/, 'a number keeps its comma');
  assert.match(html, /width:768px;height:1344px/);
});

test('pages follow the details the concept has', () => {
  assert.deepEqual(storyPages(card()), ['you', 'why', 'catalogue', 'fuse']);
  const { archetype: _a, catalogue: _c, ...bare } = card();
  assert.deepEqual(storyPages(bare), ['why', 'fuse']);
  assert.deepEqual(storySteps(card()).map((s) => `${s.page}${s.step}`), ['you0', 'you1', 'you2', 'you3', 'why0', 'why1', 'why2', 'why3', 'catalogue0', 'catalogue1', 'fuse0']);
});

test('reveal steps hide later blocks without moving anything', () => {
  const first = pageHtml('why', card(), { step: 0, interactive: false });
  assert.equal(first.steps, 4);
  assert.equal((first.html.match(/class="later"/g) ?? []).length, 2, 'reasons 2 and 3');
  assert.match(first.html, /class="block later"/, 'the artist block');
  assert.equal((pageHtml('why', card(), { step: 3 }).html.match(/later/g) ?? []).length, 0);
  const you = pageHtml('you', card(), { step: 1 });
  assert.equal((you.html.match(/class="step later"/g) ?? []).length, 2);
});

test('video frames show buttons as labels; the page gets real buttons', () => {
  const frame = frameHtml(card(), { width: 768, height: 1344, pages: storyPages(card()), index: 2, step: 1 });
  assert.doesNotMatch(frame, /<button/);
  assert.match(frame, /<span class="chip ghost">Make this one<\/span>/);
  assert.match(frame, /<div class="brand"><span>04 \/ 05<\/span>/, 'the frame shows its place in the story (the front is the first page)');
  assert.match(frame, /width:768px;height:1344px/);
  assert.equal((frame.match(/<i class="on"><\/i>/g) ?? []).length, 3, 'progress shows pages 1–3');
  assert.match(pageHtml('catalogue', card()).html, /<button class="chip ghost" type="button" data-idea="1">Make this one<\/button>/);
});

test('all page text is escaped, in frames and on the page', () => {
  for (const page of storyPages(hostile())) {
    const { html } = pageHtml(page, hostile(), { name: '<Ada>' });
    assert.doesNotMatch(html, /<script|<img|<b>Boss|<b>you|<i>so|<i>era|<svg|<Ada>/, page);
  }
});

test('the story timeline flips, slides between pages and fades within them', () => {
  const steps = storySteps(card());
  const t = storyTimeline(8, steps);
  assert.equal(t.transitions.filter((x) => x.type === 'slideleft').length, 3);
  assert.equal(t.transitions.filter((x) => x.type === 'fade').length, 7);
  const holds = steps.reduce((sum, s) => sum + s.hold, 0);
  const moves = t.transitions.reduce((sum, x) => sum + x.seconds, 0);
  assert.ok(Math.abs(t.pages - (holds + moves)) < 1e-9);
  assert.ok(Math.abs(t.flips[0] - (8 - 8 / 24)) < 1e-9);
  assert.ok(Math.abs(t.total - (8 + 8 / 24 + t.pages + 2 * 8 / 24)) < 1e-9);
  assert.equal(storyLength(card(), 8), t.total);
  assert.throws(() => storyTimeline(8, steps.slice(0, 1)), /at least two/);
});

test('the loop repeats the orbit to about sixteen seconds', () => {
  assert.deepEqual(loopLength(8), { loops: 2, total: 16 });
  assert.deepEqual(loopLength(15), { loops: 1, total: 15 });
  const args = loopArgs({ orbit: 'o.mp4', front: 'f.png', music: 'm.mp3', musicGainDb: 3, musicSeconds: 30, width: 768, height: 1344, orbitSeconds: 8, out: 'ad.mp4' });
  assert.deepEqual(args.slice(0, 4), ['-stream_loop', '1', '-i', 'o.mp4']);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /volume=3\.0dB/);
  assert.match(graph, /afade=t=out:st=14\.8:d=1\.2/);
  assert.equal(args[args.lastIndexOf('-t') + 1], '16');
  const silent = loopArgs({ orbit: 'o.mp4', front: 'f.png', width: 768, height: 1344, orbitSeconds: 8, out: 'ad.mp4' });
  assert.ok(!silent.includes('[a]'));
});

test('the story graph flips twice and chains every reveal step', () => {
  const steps = storySteps(card());
  const frames = steps.map((_, i) => `p${i}.png`);
  const args = storyArgs({ orbit: 'o.mp4', front: 'f.png', frames, steps, music: 'm.mp3', musicGainDb: 12.7, musicSeconds: 40, width: 768, height: 1344, orbitSeconds: 8, out: 'story.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal((graph.match(/perspective=/g) ?? []).length, 4);
  assert.match(graph, /in\/8/, 'perspective counts frames from 1');
  assert.equal((graph.match(/xfade=transition=slideleft/g) ?? []).length, 3);
  assert.equal((graph.match(/xfade=transition=fade/g) ?? []).length, 7);
  assert.match(graph, /concat=n=6:v=1:a=0/);
  assert.match(graph, new RegExp(`\\[${2 + frames.length + 1}:a\\]highpass`), 'the swish comes after the music input');
  assert.match(graph, /amix=inputs=3/);
  assert.match(graph, /volume=12\.7dB/);
  assert.equal(args[args.lastIndexOf('-t') + 1], String(storyTimeline(8, steps).total));
  assert.throws(() => storyArgs({ orbit: 'o', front: 'f', frames: ['one.png'], steps, width: 1, height: 1, orbitSeconds: 8, out: 'x' }), /One frame is needed/);

  const silent = storyArgs({ orbit: 'o.mp4', front: 'f.png', frames, steps, width: 768, height: 1344, orbitSeconds: 8, out: 'story.mp4' });
  const silentGraph = silent[silent.indexOf('-filter_complex') + 1];
  assert.match(silentGraph, new RegExp(`\\[${2 + frames.length}:a\\]highpass`), 'without music the swish takes the next input');
  assert.match(silentGraph, /amix=inputs=2:normalize=0,apad=whole_dur=/);
  assert.ok(!silent.includes('m.mp3'));
});

test('the orbit’s own soundtrack repeats under the loop and the whole story', () => {
  const loop = loopArgs({ orbit: 'o.mp4', front: 'f.png', music: 'o.mp4', musicLoop: true, musicGainDb: 2, width: 768, height: 1344, orbitSeconds: 8, out: 'ad.mp4' });
  assert.deepEqual(loop.slice(loop.lastIndexOf('-stream_loop'), loop.lastIndexOf('-stream_loop') + 4), ['-stream_loop', '-1', '-i', 'o.mp4']);
  assert.match(loop[loop.indexOf('-filter_complex') + 1], /afade=t=out:st=14\.8:d=1\.2/, 'it fades out at the end of the loop, not of one orbit');
  const steps = storySteps(card());
  const frames = steps.map((_, i) => `p${i}.png`);
  const story = storyArgs({ orbit: 'o.mp4', front: 'f.png', frames, steps, music: 'o.mp4', musicLoop: true, width: 768, height: 1344, orbitSeconds: 8, out: 'story.mp4' });
  const at = story.indexOf('-stream_loop');
  assert.deepEqual(story.slice(at, at + 4), ['-stream_loop', '-1', '-i', 'o.mp4']);
  assert.match(story[story.indexOf('-filter_complex') + 1], new RegExp(`\\[${2 + frames.length}:a\\]aformat`), 'the repeated soundtrack is the music input');
  const once = storyArgs({ orbit: 'o.mp4', front: 'f.png', frames, steps, music: 'm.mp3', width: 768, height: 1344, orbitSeconds: 8, out: 'story.mp4' });
  assert.ok(!once.includes('-stream_loop'), 'a music bed plays once');
});

test('music is brought to a steady loudness, within limits', () => {
  assert.equal(musicGain(-28.7), 12.7);
  assert.equal(musicGain(-10.9), -5.1);
  assert.equal(musicGain(-60), 20);
  assert.equal(musicGain(null), 0);
});

test('the share page is a story card with downloads, sound and safe embedded prompts', () => {
  const run = { created: '2026-10-13T17:00:00Z', concept: { model: 'kimi-k3', privacy: 'private', usd: 0.05 }, image: { model: 'img', usd: 0.07 }, video: { model: 'vid', usd: 0.46 }, music: { model: 'song', usd: 0.05 } };
  const prompts = { ideas: ['idea </script> one'], invite: 'invite <!-- two' };
  const page = sharePageHtml(hostile(), { video: 'ad.mp4', story: 'story.mp4', poster: 'poster.jpg', width: 768, height: 1344, run, prompts });
  assert.doesNotMatch(page, /<script>alert|<img src=x|<b>you<\/b>|<svg onload/);
  assert.doesNotMatch(page, /idea <\/script>|invite <!--/, 'embedded prompts cannot break out of their script block');
  assert.match(page, /<video src="ad.mp4" poster="poster.jpg" autoplay muted loop playsinline>/);
  // One Download button, whose menu lists each file.
  assert.equal(page.match(/<summary class="btn">Download/g)?.length, 1);
  assert.match(page, /href="story.mp4" download>Story video/);
  assert.match(page, /href="ad.mp4" download>360° loop/);
  assert.match(page, /href="poster.jpg" download>Still image/);
  // Sound starts off; it and the 360° turn are controls under the card (with no question mark: those are for the rendering stages).
  assert.match(page, /<button class="ctl" id="sound" type="button" aria-pressed="false">[\s\S]*?<span class="off">Sound off<\/span><span class="on">Sound on<\/span><\/button>/);
  assert.match(page, /<button class="ctl" id="spin" type="button" aria-pressed="true">[\s\S]*?360°<\/button>/);
  assert.doesNotMatch(page, /class="help"|class="popover"/);
  assert.match(page, /<button class="nav next" type="button" aria-label="Next page">/);
  assert.match(page, /<button class="nav prev" type="button" aria-label="Previous page">/);
  assert.doesNotMatch(page, /class="hint"|class="motto"|Tap the card for the next page/, 'the arrows replace the tap hint');
  // The story counts the pages it has (the front first), and the main button turns the card over.
  assert.match(page, /<span id="count">01 \/ 05<\/span>/);
  assert.equal(page.match(/<span class="bars">(.*?)<\/span>/)[1].match(/<i/g).length, 5);
  assert.match(page, /<button class="btn primary" id="next" type="button"><span>Flip to your story<\/span>/);
  // The caption goes out through a Share button (the page adds its own link), not as text on the page.
  assert.match(page, /<a class="btn" id="share" href="https:\/\/twitter\.com\/intent\/tweet\?text=%3C%2Fscript%3E%3Cscript%3Ealert\(3\)%3C%2Fscript%3E" target="_blank" rel="noopener">Share on X<\/a>/);
  assert.doesNotMatch(page, /Fictional example/, 'only the example says it is fictional');
  assert.doesNotMatch(page, /class="caption"|id="copy"|class="fine"/);
  assert.match(page, /data-invite/);

  assert.match(page, /≈ \$0\.63/);
  // How it was made sits in a collapsed Details section.
  assert.match(page, /<footer>\n<details class="details">\n<summary>Details <span class="caret" aria-hidden="true">▾<\/span><\/summary>\n<div class="pipeline">[\s\S]*≈ \$0\.63[\s\S]*<\/details>\n<\/footer>/);
  const data = JSON.parse(page.match(/<script type="application\/json" id="zkads-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.ideas, prompts.ideas);
  assert.equal(data.invite, prompts.invite);

  const still = sharePageHtml(card(), { video: null, story: null, poster: 'poster.jpg', width: 9, height: 16, run: { concept: { source: 'import', model: 'your own assistant' } } });
  assert.match(still, /<img src="poster.jpg" alt="The Gambit Terrarium">/);
  assert.doesNotMatch(still, /<video|>Story video|>360° loop|id="sound"/);
  assert.match(still, /href="poster.jpg" download>Still image/);
  assert.match(still, /ZKAds only received the finished concept/);
});

test('CHROME_PATH must be an executable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zkads-test-'));
  try {
    const plain = join(dir, 'not-executable');
    writeFileSync(plain, '');
    assert.notEqual(findChrome({ CHROME_PATH: dir }), dir);
    assert.notEqual(findChrome({ CHROME_PATH: plain }), plain);
    assert.equal(findChrome({ CHROME_PATH: process.execPath }), process.execPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a browser that cannot start or exits early fails cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zkads-test-'));
  const args = { htmlPath: join(dir, 'x.html'), pngPath: join(dir, 'x.png'), width: 10, height: 10, timeoutMs: 5000 };
  try {
    await assert.rejects(screenshotHtml({ ...args, chrome: join(dir, 'missing-browser') }), /Could not start Chrome/);
    await assert.rejects(screenshotHtml({ ...args, chrome: '/usr/bin/false' }), /Chrome exited \(1\) without a screenshot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tools = Boolean(findChrome()) && (await hasFfmpeg());
test('share renders the loop, the story and the page; stale videos are left out and removed', { skip: !tools && 'needs Chrome and ffmpeg' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zkads-share-'));
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  const probe = (path, entries) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim();
  try {
    ffmpeg('-f', 'lavfi', '-i', 'color=c=0x334455:s=288x512', '-frames:v', '1', join(dir, 'hero.png'));
    // The orbit's audio runs longer than its picture, as generated orbits can.
    ffmpeg('-f', 'lavfi', '-i', 'color=c=0x554433:s=288x504:d=2:r=24', '-f', 'lavfi', '-i', 'sine=f=200:d=2.6', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'orbit.mp4'));
    ffmpeg('-f', 'lavfi', '-i', 'sine=f=330:d=40', join(dir, 'music.mp3'));
    const heroSha = digest(readFileSync(join(dir, 'hero.png')));
    const music = { status: 'done', file: 'music.mp3', model: 'song', usd: 0.05 };
    const quiet = () => {};

    const fresh = await renderShare({ dir, concept: card(), run: { orbit: { hero_sha256: heroSha }, music }, log: quiet });
    assert.deepEqual(fresh, { video: 'ad.mp4', story: 'story.mp4', poster: 'poster.jpg', music: 'music.mp3' });
    assert.match(probe(join(dir, 'story.mp4'), 'stream=codec_type,width,height'), /video,288,504[\s\S]*audio/);
    const expected = storyLength(card(), 2);
    assert.ok(Math.abs(Number(probe(join(dir, 'story.mp4'), 'format=duration')) - expected) < 0.15, 'story length follows the picture, not the longer audio');
    assert.ok(Math.abs(Number(probe(join(dir, 'ad.mp4'), 'format=duration')) - loopLength(2).total) < 0.15);
    const lufs = await loudness(join(dir, 'story.mp4'));
    assert.ok(lufs > -22 && lufs < -12, `story loudness ${lufs} LUFS`);
    assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /<video src="ad.mp4"/);

    // Without a music file, an orbit asked for sound plays its own soundtrack under the whole story;
    // an older orbit that was not asked for sound stays silent.
    rmSync(join(dir, 'music.mp3'));
    await renderShare({ dir, concept: card(), run: { orbit: { hero_sha256: heroSha, sound: true }, video: { model: 'orbit-model' } }, site: 'https://zkads.example', card: 'c'.repeat(20), log: quiet });
    assert.match(probe(join(dir, 'story.mp4'), 'stream=codec_type'), /audio/);
    // Well after the 2 s orbit, on the pages, the soundtrack is still playing.
    ffmpeg('-ss', '8', '-t', '4', '-i', join(dir, 'story.mp4'), '-vn', join(dir, 'later.wav'));
    const laterLufs = await loudness(join(dir, 'later.wav'));
    assert.ok(laterLufs > -30, `the soundtrack carries on past the orbit (${laterLufs} LUFS from 8 s)`);
    const ownPage = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(ownPage, /orbit-model · 360° orbit and sound/);
    assert.ok(ownPage.includes(`href="https://zkads.example/catalogue?card=${'c'.repeat(20)}&amp;item=0"`), 'a hosted card links its catalogue into the app');
    await renderShare({ dir, concept: card(), run: { orbit: { hero_sha256: heroSha, sound: false }, video: { model: 'orbit-model', status: 'done', sound: true } }, log: quiet });
    assert.doesNotMatch(readFileSync(join(dir, 'index.html'), 'utf8'), /360° orbit and sound|orbit and its sound/, 'the record of this orbit.mp4 decides, not a later job');
    assert.ok(!readFileSync(join(dir, 'index.html'), 'utf8').includes('/catalogue?card='), 'a card from the command line keeps its copy buttons');

    // An in-flight job for a new hero must not vouch for the old orbit.mp4, and
    // an older run without run.orbit falls back to its finished job record.
    for (const run of [{ orbit: { hero_sha256: 'older' }, video: { status: 'queued', hero_sha256: heroSha } }, { video: { status: 'done', hero_sha256: 'older' } }]) {
      const stale = await renderShare({ dir, concept: card(), run, log: quiet });
      assert.equal(stale.video, null);
      assert.equal(stale.story, null);
      assert.ok(!existsSync(join(dir, 'ad.mp4')) && !existsSync(join(dir, 'story.mp4')), 'stale videos are removed');
      assert.doesNotMatch(readFileSync(join(dir, 'index.html'), 'utf8'), /<video/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Loads HTML in headless Chrome and returns the DOM after its scripts ran.
async function chromeDom(html) {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'zkads-dom-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, html);
  const child = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', `--user-data-dir=${join(dir, 'profile')}`, '--window-size=900,1400', '--virtual-time-budget=3000', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), '--dump-dom', pathToFileURL(file).href], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && !out.includes('</html>'); ) await new Promise((r) => setTimeout(r, 100));
    return out;
  } finally {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp profile is harmless.
    }
  }
}
const resultOf = (dom) => JSON.parse(dom.match(/data-result="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

test('the fitting script shrinks only what shrinking cures', { skip: !findChrome() && 'needs Chrome' }, async () => {
  const sheet = (label, inner) => `<div class="sheet" data-label="${label}" style="position:relative;width:768px;height:1344px"><article class="page">${inner}</article></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${sheetCss(card())}</style></head><body>
${sheet('fits', '<div class="step"><p class="reading">A short read.</p></div>')}
${sheet('long', `<div class="step"><p class="reading">${'word '.repeat(600)}</p></div>`)}
${sheet('stuck', '<div class="step"><div style="width:2000px;height:4px"></div></div>')}
${FIT_SCRIPT}
<script>document.body.dataset.result = JSON.stringify(Object.fromEntries([...document.querySelectorAll('.sheet')].map((s) => [s.dataset.label, s.querySelector('.page').style.getPropertyValue('--fit') || '1'])));</script>
</body></html>`;
  const fits = resultOf(await chromeDom(html));
  assert.equal(fits.fits, '1');
  assert.ok(Number(fits.long) < 1, 'text too long for the page is shrunk');
  assert.equal(fits.stuck, '1', 'an overflow that shrinking cannot cure leaves the text at full size');
});

test('a card measured before it had a size is fitted again once it grows', { skip: !findChrome() && 'needs Chrome' }, async () => {
  // A page opened in a background tab or a preview can run its scripts at no size at all.
  const pages = storyPages(card()).map((page) => pageHtml(page, card(), { name: 'Ada', interactive: false }).html).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${sheetCss(card())}</style></head><body>
<div class="sheet" id="sheet" style="position:relative;width:0;height:0">${pages}</div>
${FIT_SCRIPT}
<script>
const fits = () => [...document.querySelectorAll('.page')].map((p) => p.style.getPropertyValue('--fit') || '1');
setTimeout(() => {
  Object.assign(document.getElementById('sheet').style, { width: '400px', height: '700px' });
  dispatchEvent(new Event('resize'));
  setTimeout(() => (document.body.dataset.result = JSON.stringify(fits())), 300);
}, 100);
</script>
</body></html>`;
  // The old script measured once and kept the shrink it chose at no size (about half).
  assert.deepEqual(resultOf(await chromeDom(html)), ['1', '1', '1', '1']);
});

test('every page fits the card at maximum length, in wide and narrow typefaces', { skip: !findChrome() && 'needs Chrome' }, async () => {
  const x = (n, word = 'word') => `${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n).trim();
  const stress = validateConcept({
    ...sampleConcept(),
    product_name: x(48, 'Hyperparameterized'),
    era: x(48, 'Constantinople'),
    artist: x(48, 'Hundertwasser'),
    archetype: 'The Hyperparameterizer of Quadratic Encores',
    reading: x(120),
    stat_value: '999,999,999+',
    stat_label: x(80),
    rabbit_hole: x(90, 'antidisestablishmentarianism'),
    era_match: x(110),
    reasons: [0, 1, 2].map(() => ({ you: x(90), so: x(90) })),
    artist_reason: x(90),
    catalogue: [0, 1].map(() => ({ name: x(48, 'Supercalifragilistic'), era: x(64), teaser: x(110) })),
  });
  const wide = validateConcept({ ...stress, stat_value: 'WWWWWWWWWWWW' });
  // A sponsored slot at its longest, beside two catalogue items at theirs.
  const sponsored = { ...stress, sponsored: { brand: x(40, 'Encore'), name: x(48, 'Supercalifragilistic'), era: x(64), teaser: x(110), credits: 999 } };
  // The 'you' page with both its own stat and a usage badge at their longest.
  const badged = { ...stress, badge: { value: '999,999,999+', label: x(60), source: 'zktls' } };
  const sheets = ['Menlo', 'Copperplate', 'Futura', 'Didot'].flatMap((face) => {
    const style = `--display:${TYPEFACES[face].replace(/"/g, '&quot;')}`;
    const sheet = (label, concept, page, options = {}) => `<div class="sheet" data-label="${face}/${label}/${page}" style="${style}">${pageHtml(page, concept, { name: 'Ada', interactive: false, ...options }).html}</div>`;
    return [...storyPages(stress).map((page) => sheet('stress', stress, page)), ...storyPages(card()).map((page) => sheet('card', card(), page)), sheet('wide-stat', wide, 'you'), sheet('sponsored', sponsored, 'catalogue'), sheet('badged', badged, 'you'), sheet('matchable', stress, 'fuse', { matchable: true })];
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${sheetCss(stress)}.sheet{position:relative;width:768px;height:1344px;margin-bottom:8px}</style></head><body>${sheets.join('')}
${FIT_SCRIPT}
<script>
const failures = [];
for (const sheet of document.querySelectorAll('.sheet')) {
  // Content must stay inside the page's padding, i.e. clear of the frame line.
  const page = sheet.querySelector('.page');
  const pr = page.getBoundingClientRect();
  const ps = getComputedStyle(page);
  const inner = { left: pr.left + parseFloat(ps.paddingLeft), right: pr.right - parseFloat(ps.paddingRight), bottom: pr.bottom - parseFloat(ps.paddingBottom) };
  for (const el of page.querySelectorAll(':scope > :not(.brand), :scope > :not(.brand) *')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.left < inner.left - 1 || r.right > inner.right + 1 || r.bottom > inner.bottom + 1)) { failures.push(sheet.dataset.label + ' ' + el.className); break; }
  }
  const tile = sheet.querySelector('.stat');
  if (tile && tile.querySelector('span').getBoundingClientRect().width < tile.getBoundingClientRect().width * 0.25) failures.push(sheet.dataset.label + ' stat label squeezed');
  const brand = sheet.querySelector('.brand');
  if (getComputedStyle(brand).position !== 'absolute') failures.push(sheet.dataset.label + ' brand in flow');
  const stat = sheet.querySelector('.stat b');
  if (stat && stat.getBoundingClientRect().height > parseFloat(getComputedStyle(stat).fontSize) * 1.5) failures.push(sheet.dataset.label + ' stat wraps');
  const statTile = sheet.querySelector('.stat');
  if (statTile && stat.getBoundingClientRect().right > statTile.getBoundingClientRect().right + 1) failures.push(sheet.dataset.label + ' stat number leaves its tile');
}
const fitOf = (sheet) => Number(sheet.querySelector('.page').style.getPropertyValue('--fit') || 1);
const sheetsAll = [...document.querySelectorAll('.sheet')];
const smallest = Math.min(...sheetsAll.map(fitOf));
const shrunkCards = sheetsAll.filter((s) => s.dataset.label.includes('/card/') && fitOf(s) !== 1).map((s) => s.dataset.label);
document.body.setAttribute('data-result', JSON.stringify({ failures, sheets: sheetsAll.length, smallest, shrunkCards }));
</script></body></html>`;
  const result = resultOf(await chromeDom(html));
  assert.equal(result.sheets, 48);
  assert.deepEqual(result.failures, []);
  assert.ok(result.smallest >= 0.6, `type shrank to ${result.smallest}`);
  assert.deepEqual(result.shrunkCards, [], 'ordinary cards keep full-size type');
});

// Synthetic key events reach the page's handlers but never press a button, so
// this checks the page-turning logic, not the browser's own button activation.
test('Enter and Space on a focused card button never turn the page; the arrows still do', { skip: !findChrome() && 'needs Chrome' }, async () => {
  const page = sharePageHtml(card(), { video: null, story: null, poster: 'poster.jpg', width: 768, height: 1344, run: {}, prompts: { ideas: ['a', 'b'], invite: 'c' } });
  const probe = `<script>
const current = () => [...document.querySelectorAll('.page')].findIndex((p) => p.classList.contains('on'));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
show(2);
const button = document.querySelector('[data-idea="0"]');
button.focus();
key(button, 'Enter');
const afterEnter = current();
key(button, ' ');
const afterSpace = current();
key(button, 'ArrowRight');
const afterArrow = current();
const focusBack = document.activeElement === document.getElementById('card');
document.body.setAttribute('data-result', JSON.stringify({ afterEnter, afterSpace, afterArrow, focusBack }));
</script>`;
  const result = resultOf(await chromeDom(page.replace('</body>', `${probe}</body>`)));
  assert.deepEqual(result, { afterEnter: 2, afterSpace: 2, afterArrow: 3, focusBack: true });
});

test('ordinary content keeps full-size type; frames and the page carry the fit script', () => {
  assert.ok(frameHtml(card(), { width: 768, height: 1344, pages: storyPages(card()), index: 0, step: 0 }).includes(FIT_SCRIPT));
  assert.ok(sharePageHtml(card(), { video: null, story: null, poster: 'p.jpg', width: 9, height: 16, run: {} }).includes(FIT_SCRIPT));
});

test('a link to one page opens on it without playing the flip', { skip: !findChrome() && 'needs Chrome' }, async () => {
  const page = sharePageHtml(card(), { video: null, story: null, poster: 'poster.jpg', width: 768, height: 1344, run: {} });
  const recorder = '<script>window.flips = 0; document.addEventListener("transitionrun", () => window.flips++);</script>';
  const report = `<script>setTimeout(() => document.body.setAttribute('data-result', JSON.stringify({ flips: window.flips, flipped: document.getElementById('card').classList.contains('flipped'), shown: [...document.querySelectorAll('.page')].findIndex((p) => p.classList.contains('on')) })), 1500);</script>`;
  const html = page.replace('<body>', `<body>${recorder}`).replace('</body>', `${report}</body>`);
  const dir = mkdtempSync(join(tmpdir(), 'zkads-hash-'));
  try {
    writeFileSync(join(dir, 'page.html'), html);
    const result = resultOf(await chromeDom(html.replace('location.hash', '"#page-3"')));
    assert.deepEqual(result, { flips: 0, flipped: true, shown: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the landing page’s example says it is fictional and leads into the app', () => {
  const page = sharePageHtml(card(), { video: 'ad.mp4', story: 'story.mp4', poster: 'poster.jpg', width: 768, height: 1344, run: { concept: { source: 'import', model: 'your own assistant' }, video: { model: 'vid' } }, site: 'https://zkads.example', fictional: true });
  assert.match(page, /<span class="tag">Fictional example<\/span>/);
  assert.match(page, /A fictional example: ZK Ads wrote this concept for an imagined maker/);
  assert.doesNotMatch(page, /Your own assistant read your history|Chat history/);
  assert.ok(page.includes('<a class="chip ghost" href="https://zkads.example/">Make this one</a>'));
  assert.ok(page.includes('<a class="chip big-chip" href="https://zkads.example/">Invite a friend</a>'));
  assert.match(page, /This is an example: make your own card first, then invite a friend from it\./);
});

test('the fuse page invites, and finds a match on a hosted card', () => {
  const hosted = pageHtml('fuse', card(), { links: { idea: () => '', invite: 'https://zkads.example/invite?card=x', match: 'https://zkads.example/match?card=x' } }).html;
  assert.match(hosted, /<h2 class="title">Two ways of thinking\. One custom invention\.<\/h2>/);
  assert.match(hosted, /Invite a friend\. Make a shared 1\/1\./);
  assert.ok(hosted.includes('<a class="chip ghost" href="https://zkads.example/match?card=x">Find a match</a>'));
  assert.doesNotMatch(pageHtml('fuse', card()).html, /Find a match/, 'matching needs the hosted app');
  assert.match(pageHtml('fuse', card(), { interactive: false, matchable: true }).html, /<span class="chip ghost">Find a match<\/span>/, 'a hosted card’s video shows it');
  assert.doesNotMatch(pageHtml('fuse', card(), { interactive: false }).html, /Find a match|Back to the object/, 'a command-line card’s video does not');
});
