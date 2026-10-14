// Builds Venice image/video requests from public model metadata, so the
// model can be swapped by flag without hand-tuning each request.
import { createHash } from 'node:crypto';

export const ORBIT_MODEL = 'minimax-h3-max-multi-angle';
export const MUSIC_MODEL = 'sonilo-v1-1-music';

export function imageGuardrails(aspectRatio) {
  return [
    `Composition: ${aspectRatio} hero product shot. Exactly one object, centered and fully visible with generous margins,`,
    'filling about half the frame height. Keep the top fifth and bottom fifth of the frame calm and empty.',
    'Absolutely no text, letters, numbers, logos, labels or watermarks. No people, hands or faces.',
  ].join(' ');
}

export const ORBIT_GUARDRAILS = [
  'The object stays perfectly still and centered while the camera makes one smooth, constant-speed 360-degree orbit around it',
  'and ends exactly where it began. Shape, materials, colors and lighting stay consistent from every angle.',
  'No text, no people, no morphing.',
].join(' ');

// One full orbit at constant speed that ends where it starts, so the clip loops.
// Azimuth/elevation are degrees relative to the input image's viewpoint.
export function orbitTrajectory({ keyframes = 5, turns = 1, elevation = 0 } = {}) {
  if (keyframes < 2 || keyframes > 12) throw new Error('camera_trajectory needs 2–12 keyframes');
  return Array.from({ length: keyframes }, (_, i) => {
    const time = i / (keyframes - 1);
    return { time, azimuth: 360 * turns * time, elevation, distance: 1 };
  });
}

export function imageRequest(spec, { prompt, aspectRatio = '9:16', hd = false }) {
  const c = spec.model_spec?.constraints ?? {};
  const limit = c.promptCharacterLimit ?? 1500;
  if (prompt.length > limit) {
    throw new Error(`Image prompt is ${prompt.length} characters; ${spec.id} allows ${limit}. Shorten image_prompt in concept.json.`);
  }
  const body = { model: spec.id, prompt, format: 'png', hide_watermark: true, safe_mode: true };
  if (c.aspectRatios?.length) {
    if (!c.aspectRatios.includes(aspectRatio)) {
      throw new Error(`${spec.id} does not support ${aspectRatio}; it supports ${c.aspectRatios.join(', ')}`);
    }
    body.aspect_ratio = aspectRatio;
  } else {
    Object.assign(body, pixelSize(aspectRatio, c.widthHeightDivisor ?? 8));
  }
  if (c.resolutions?.length) {
    body.resolution = hd && c.resolutions.includes('2K') ? '2K' : c.defaultResolution ?? c.resolutions[0];
  }
  if (c.qualities?.length) body.quality = ['high', 'medium', 'low'].find((q) => c.qualities.includes(q));
  return body;
}

// Older models take width/height (max 1280) instead of an aspect ratio.
function pixelSize(aspectRatio, divisor) {
  const [w, h] = aspectRatio.split(':').map(Number);
  const scale = 1280 / Math.max(w, h);
  const snap = (n) => Math.floor((n * scale) / divisor) * divisor;
  return { width: snap(w), height: snap(h) };
}

export function videoRequest(spec, { prompt, imageDataUrl, seconds, hd = false }) {
  const c = spec.model_spec?.constraints ?? {};
  if (c.model_type !== 'image-to-video') throw new Error(`${spec.id} is not an image-to-video model`);
  const duration = `${seconds}s`;
  if (c.durations?.length && !c.durations.includes(duration)) {
    throw new Error(`${spec.id} supports durations ${c.durations.join(', ')}`);
  }
  const body = { model: spec.id, duration, image_url: imageDataUrl, prompt };
  if (c.resolutions?.length) body.resolution = closestResolution(c.resolutions, hd ? 1080 : 720);
  // Only the multi-angle model takes an explicit camera path; others rely on the prompt.
  if (spec.id === ORBIT_MODEL) body.camera_trajectory = orbitTrajectory();
  return body;
}

function closestResolution(options, target) {
  const lines = (r) => ({ '2k': 1440, '4k': 2160 })[r.toLowerCase()] ?? parseInt(r, 10);
  return [...options].sort((a, b) => Math.abs(lines(a) - target) - Math.abs(lines(b) - target) || lines(b) - lines(a))[0];
}

export function textCost(spec, usage) {
  const p = spec.model_spec?.pricing;
  if (!p?.input || !usage) return null;
  return ((usage.prompt_tokens ?? 0) * p.input.usd + (usage.completion_tokens ?? 0) * p.output.usd) / 1e6;
}

export function imageCost(spec, body) {
  const p = spec.model_spec?.pricing ?? {};
  return p.quality?.[body.resolution]?.[body.quality]?.usd ?? p.resolutions?.[body.resolution]?.usd ?? p.generation?.usd ?? null;
}

export function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}


// Concepts written before music_prompt existed still get a period-appropriate bed.
export function musicPromptFor(concept) {
  if (concept.music_prompt) return concept.music_prompt;
  const flavour = concept.setting === 'sci-fi' ? 'retro-futuristic' : 'vintage';
  return `Instrumental music bed for a short ${flavour} advertisement set in ${concept.era}: period-appropriate instruments and style, elegant, playful and warm. No vocals.`;
}

export function musicRequest(spec, { prompt, seconds }) {
  const m = spec.model_spec ?? {};
  const limit = m.prompt_character_limit ?? 300;
  const timed = m.min_duration != null || m.max_duration != null;
  // Models without a duration setting can only be asked in words.
  const length = timed ? '' : ` About ${Math.ceil(seconds)} seconds long.`;
  const body = { model: spec.id, prompt: `${prompt.slice(0, Math.max(0, limit - length.length))}${length}` };
  if (timed) {
    body.duration_seconds = Math.min(Math.max(Math.ceil(seconds), m.min_duration ?? 1), m.max_duration ?? Infinity);
  }
  if (m.supports_force_instrumental) body.force_instrumental = true;
  return body;
}

export function audioExtension(contentType) {
  const type = contentType.split(';')[0].trim();
  return { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac' }[type] ?? 'mp3';
}
