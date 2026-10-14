// The paid generation steps for one run folder (hero image, 360° orbit,
// music bed), shared by the CLI and the enclave service. Each step records
// what it made in run.json; the orbit and music use the resumable job runner.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConcept } from './concept.mjs';
import { audioExtension, digest, imageCost, imageGuardrails, imageRequest, musicPromptFor, musicRequest, ORBIT_GUARDRAILS, videoRequest } from './media.mjs';
import { readJson, readRun, runPaidJob, updateRun } from './run.mjs';
import { storyLength } from './share.mjs';
import { describe } from './venice.mjs';

export const ASPECT = '9:16';
const silent = { announce() {}, note() {}, progress() {} };

// concept.json may be hand-edited, so its shape is re-checked on every load
// (its text was checked for personal details when it was first accepted).
export function readConcept(dir) {
  return validateConcept(readJson(join(dir, 'concept.json')), { stored: true });
}

export async function makeImage({ venice, dir, model, hd = false, announce = () => {} }) {
  const concept = readConcept(dir);
  const spec = await venice.model('image', model);
  const prompt = `${concept.image_prompt}\n\n${imageGuardrails(ASPECT)}`;
  const body = imageRequest(spec, { prompt, aspectRatio: ASPECT, hd });
  announce(`${spec.id} ${[body.resolution, body.quality].filter(Boolean).join(' ')}…`);
  const started = Date.now();
  const png = await venice.generateImage(body);
  const file = `hero.${spec.id}.png`;
  writeFileSync(join(dir, file), png);
  copyFileSync(join(dir, file), join(dir, 'hero.png'));
  updateRun(dir, {
    image: { model: spec.id, privacy: spec.model_spec?.privacy, resolution: body.resolution ?? null, quality: body.quality ?? null, usd: imageCost(spec, body), seconds: Math.round((Date.now() - started) / 1000), prompt },
  });
  return { file };
}

// `sound: 'video'` (the default) asks the video model for the soundtrack too,
// from the concept's music idea; the default orbit model always makes sound.
// 'music' leaves the sound to a separate music model (makeMusic).
export async function makeOrbit({ venice, dir, model, seconds, hd = false, sound = 'video', resumeCommand, hooks = silent }) {
  const concept = readConcept(dir);
  const spec = await venice.model('video', model);
  const hero = readFileSync(join(dir, 'hero.png'));
  return runPaidJob({
    venice,
    dir,
    key: 'video',
    kind: 'video',
    spec,
    resumeCommand,
    ...hooks,
    build: () => {
      const body = videoRequest(spec, {
        prompt: [concept.orbit_prompt, ORBIT_GUARDRAILS, sound === 'video' && `Sound: ${musicPromptFor(concept)} Instrumental only, with no speech or vocals.`].filter(Boolean).join('\n\n'),
        imageDataUrl: `data:image/png;base64,${hero.toString('base64')}`,
        seconds,
        hd,
      });
      return {
        body,
        quote: { model: body.model, duration: body.duration, resolution: body.resolution },
        summary: `${body.duration} ${body.resolution ?? ''}`,
        record: { duration: body.duration, resolution: body.resolution ?? null, hero_sha256: digest(hero), camera_trajectory: body.camera_trajectory ?? null, prompt: body.prompt, sound: sound === 'video' },
      };
    },
    save: ({ data }, job) => {
      writeFileSync(join(dir, 'orbit.mp4'), data);
      // Which hero this file shows, kept apart from any later in-flight job.
      updateRun(dir, { orbit: { hero_sha256: job.hero_sha256 ?? null, model: job.model, sound: job.sound === true } });
      return 'orbit.mp4';
    },
  });
}

export async function makeMusic({ venice, dir, model, fallbackSeconds = 8, resumeCommand, hooks = silent }) {
  const concept = readConcept(dir);
  const spec = await venice.model('music', model);
  const orbitSeconds = parseInt(readRun(dir).video?.duration, 10) || fallbackSeconds;
  // Long enough for the whole story video, plus a second so the fade never runs short.
  const seconds = storyLength(concept, orbitSeconds) + 1;
  return runPaidJob({
    venice,
    dir,
    key: 'music',
    kind: 'audio',
    spec,
    resumeCommand,
    ...hooks,
    build: () => {
      const body = musicRequest(spec, { prompt: musicPromptFor(concept), seconds });
      return {
        body,
        quote: { model: body.model, duration_seconds: body.duration_seconds },
        summary: body.duration_seconds ? `${body.duration_seconds}s` : '',
        record: { prompt: body.prompt, duration_seconds: body.duration_seconds ?? null },
      };
    },
    save: ({ data, type }) => {
      const file = `music.${audioExtension(type)}`;
      writeFileSync(join(dir, file), data);
      return file;
    },
  });
}

// All the paid media for a card folder, skipping whatever an earlier attempt
// finished and collecting paid jobs still in flight rather than buying them
// again. `progress(step)` runs before each paid step (and may throw to stop).
// Sound comes from the orbit's own soundtrack (`sound: 'video'`, the default)
// or from a separate music model ('music'), which is optional: if it fails,
// the card goes on without it.
export async function makeMedia({ venice, dir, models, seconds, sound = 'video', progress = async () => {}, log = () => {} }) {
  const hooks = { announce: log, note: log, progress() {} };
  if (!(readRun(dir).image && existsSync(join(dir, 'hero.png')))) {
    await progress('image');
    await makeImage({ venice, dir, model: models.image, announce: log });
  }
  const hero = digest(readFileSync(join(dir, 'hero.png')));
  if (!(readRun(dir).orbit?.hero_sha256 === hero && existsSync(join(dir, 'orbit.mp4')))) {
    await progress('orbit');
    await makeOrbit({ venice, dir, model: models.video, seconds, sound, hooks });
  }
  if (sound !== 'music') return;
  const music = readRun(dir).music;
  if (!(music?.status === 'done' && music.file && existsSync(join(dir, music.file)))) {
    await progress('music');
    try {
      await makeMusic({ venice, dir, model: models.music, fallbackSeconds: seconds, hooks });
    } catch (error) {
      // The paid video is already safe; finish the card without music.
      log(`music failed (${describe(error)}); continuing without it`);
    }
  }
}
