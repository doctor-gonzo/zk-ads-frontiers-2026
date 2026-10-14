import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HISTORY_CHARS } from '../lib/concept.mjs';
import { audioExtension, digest, imageCost, imageGuardrails, imageRequest, musicPromptFor, musicRequest, ORBIT_MODEL, orbitTrajectory, textCost, videoRequest } from '../lib/media.mjs';

const gptImage = {
  id: 'gpt-image-2-5-sunburst',
  model_spec: {
    constraints: { promptCharacterLimit: 10000, defaultResolution: '1K', resolutions: ['1K', '2K', '4K'], qualities: ['low', 'medium', 'high'], aspectRatios: ['1:1', '9:16'] },
    pricing: { resolutions: { '1K': { usd: 0.07 }, '2K': { usd: 0.15 } }, quality: { '1K': { high: { usd: 0.07 } }, '2K': { high: { usd: 0.15 } } } },
  },
};
const grokImage = {
  id: 'grok-imagine-image-2-0',
  model_spec: { constraints: { promptCharacterLimit: 7500, resolutions: ['1K', '2K'], qualities: ['low', 'medium'], aspectRatios: ['9:16'] }, pricing: {} },
};
const sdImage = {
  id: 'venice-sd35',
  model_spec: { constraints: { promptCharacterLimit: 1500, widthHeightDivisor: 16 }, pricing: { generation: { usd: 0.01 } } },
};
const orbitVideo = {
  id: ORBIT_MODEL,
  model_spec: { constraints: { model_type: 'image-to-video', resolutions: ['480P', '768P', '1080P'], durations: ['5s', '8s', '15s'] } },
};
const plainVideo = {
  id: 'kling-o3-pro-image-to-video',
  model_spec: { constraints: { model_type: 'image-to-video', resolutions: [], durations: ['5s', '10s'] } },
};

test('the orbit is one full constant-speed turn that loops', () => {
  const path = orbitTrajectory();
  assert.equal(path.length, 5);
  assert.deepEqual(path[0], { time: 0, azimuth: 0, elevation: 0, distance: 1 });
  assert.deepEqual(path.at(-1), { time: 1, azimuth: 360, elevation: 0, distance: 1 });
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].time > path[i - 1].time);
    assert.equal(path[i].azimuth - path[i - 1].azimuth, 90);
  }
  assert.throws(() => orbitTrajectory({ keyframes: 1 }), /2–12/);
  assert.throws(() => orbitTrajectory({ keyframes: 13 }), /2–12/);
});

test('the multi-angle model gets an explicit camera path', () => {
  const body = videoRequest(orbitVideo, { prompt: 'spin', imageDataUrl: 'data:image/png;base64,AA', seconds: 8 });
  assert.deepEqual(body, {
    model: ORBIT_MODEL,
    duration: '8s',
    image_url: 'data:image/png;base64,AA',
    prompt: 'spin',
    resolution: '768P',
    camera_trajectory: orbitTrajectory(),
  });
  assert.equal(videoRequest(orbitVideo, { prompt: 'p', imageDataUrl: 'x', seconds: 8, hd: true }).resolution, '1080P');
});

test('other video models rely on the prompt and are validated before spending', () => {
  const body = videoRequest(plainVideo, { prompt: 'spin', imageDataUrl: 'x', seconds: 5 });
  assert.equal(body.camera_trajectory, undefined);
  assert.equal(body.resolution, undefined);
  assert.throws(() => videoRequest(plainVideo, { prompt: 'p', imageDataUrl: 'x', seconds: 8 }), /durations 5s, 10s/);
  const textOnly = { id: 't2v', model_spec: { constraints: { model_type: 'text-to-video' } } };
  assert.throws(() => videoRequest(textOnly, { prompt: 'p', imageDataUrl: 'x', seconds: 5 }), /not an image-to-video/);
});

test('image requests only send parameters the model supports', () => {
  assert.deepEqual(imageRequest(gptImage, { prompt: 'p' }), {
    model: 'gpt-image-2-5-sunburst',
    prompt: 'p',
    format: 'png',
    hide_watermark: true,
    safe_mode: true,
    aspect_ratio: '9:16',
    resolution: '1K',
    quality: 'high',
  });
  assert.equal(imageRequest(gptImage, { prompt: 'p', hd: true }).resolution, '2K');
  assert.equal(imageRequest(grokImage, { prompt: 'p' }).quality, 'medium');
  const sd = imageRequest(sdImage, { prompt: 'p' });
  assert.deepEqual([sd.width, sd.height, sd.aspect_ratio, sd.resolution], [720, 1280, undefined, undefined]);
  assert.throws(() => imageRequest(gptImage, { prompt: 'p', aspectRatio: '21:9' }), /does not support 21:9/);
  assert.throws(() => imageRequest(sdImage, { prompt: 'x'.repeat(1501) }), /allows 1500/);
});

test('the longest allowed image prompt still fits a 1,500-character model', () => {
  const prompt = `${'x'.repeat(1100)}\n\n${imageGuardrails('9:16')}`;
  assert.ok(prompt.length <= 1500, `${prompt.length} characters`);
  assert.ok(MAX_HISTORY_CHARS > 0);
});

test('costs come from published pricing', () => {
  assert.equal(imageCost(gptImage, { resolution: '2K', quality: 'high' }), 0.15);
  assert.equal(imageCost(sdImage, {}), 0.01);
  assert.equal(imageCost(grokImage, { resolution: '1K', quality: 'medium' }), null);
  const kimi = { model_spec: { pricing: { input: { usd: 3.75 }, output: { usd: 18.75 } } } };
  assert.equal(textCost(kimi, { prompt_tokens: 4000, completion_tokens: 2000 }), 0.0525);
  assert.equal(textCost(kimi, null), null);
});

test('hero digests identify the exact image', () => {
  assert.equal(digest(Buffer.from('a')), digest(Buffer.from('a')));
  assert.notEqual(digest(Buffer.from('a')), digest(Buffer.from('b')));
});

test('music requests follow each model\'s duration, instrumental and prompt limits', () => {
  const sonilo = { id: 'sonilo-v1-1-music', model_spec: { min_duration: 1, max_duration: 600, prompt_character_limit: 4096 } };
  const eleven = { id: 'elevenlabs-music-v2-5', model_spec: { min_duration: 3, max_duration: 600, supports_force_instrumental: true, prompt_character_limit: 4096 } };
  const minimax = { id: 'minimax-music-v26', model_spec: { supports_force_instrumental: true, prompt_character_limit: 300 } };
  assert.deepEqual(musicRequest(sonilo, { prompt: 'waltz', seconds: 15.75 }), { model: 'sonilo-v1-1-music', prompt: 'waltz', duration_seconds: 16 });
  assert.deepEqual(musicRequest(eleven, { prompt: 'waltz', seconds: 1 }), { model: 'elevenlabs-music-v2-5', prompt: 'waltz', duration_seconds: 3, force_instrumental: true });
  const long = musicRequest(minimax, { prompt: 'x'.repeat(400), seconds: 16 });
  assert.equal(long.prompt.length, 300);
  assert.ok(long.prompt.endsWith(' About 16 seconds long.'), 'untimed models are asked for the length in words');
  assert.equal(long.duration_seconds, undefined);
  assert.doesNotMatch(musicRequest(sonilo, { prompt: 'waltz', seconds: 16 }).prompt, /seconds long/);
});

test('concepts without a music prompt still get a period bed; files get the right extension', () => {
  assert.equal(musicPromptFor({ music_prompt: 'A cakewalk for banjo.' }), 'A cakewalk for banjo.');
  assert.match(musicPromptFor({ era: 'Paris, 1900', setting: 'historical' }), /vintage advertisement set in Paris, 1900.*No vocals/);
  assert.match(musicPromptFor({ era: 'Ceres Belt, 2381', setting: 'sci-fi' }), /retro-futuristic/);
  assert.equal(audioExtension('audio/mpeg'), 'mp3');
  assert.equal(audioExtension('audio/wav; charset=binary'), 'wav');
  assert.equal(audioExtension('audio/mp4'), 'm4a');
  assert.equal(audioExtension('application/octet-stream'), 'mp3');
});
