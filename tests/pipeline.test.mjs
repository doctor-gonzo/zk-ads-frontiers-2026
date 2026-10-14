import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMedia } from '../lib/pipeline.mjs';
import { readRun, updateRun, writeJson } from '../lib/run.mjs';
import { VeniceError } from '../lib/venice.mjs';
import { sampleConcept } from './fixtures.mjs';

const MODELS = { image: 'img-1', video: 'minimax-h3-max-multi-angle', music: 'music-1' };
const SPECS = {
  image: { id: 'img-1', model_spec: { constraints: { aspectRatios: ['9:16'] } } },
  video: { id: 'minimax-h3-max-multi-angle', model_spec: { constraints: { model_type: 'image-to-video', durations: ['8s'] } } },
  music: { id: 'music-1', model_spec: { min_duration: 5, max_duration: 60 } },
};

// A stand-in for the Venice client that records every call that would cost money.
function fakeVenice({ music = async () => ({ data: Buffer.from('m4a'), type: 'audio/mp4' }) } = {}) {
  const calls = [];
  return {
    calls,
    paid: () => calls.filter(([name]) => name === 'generateImage' || name === 'queue'),
    model: async (type) => SPECS[type],
    generateImage: async () => (calls.push(['generateImage']), Buffer.from(`png-${calls.length}`)),
    quote: async () => 0.1,
    queue: async (kind) => (calls.push(['queue', kind]), { queue_id: `${kind}-${calls.length}` }),
    waitFor: async (kind, options) => (calls.push(['waitFor', kind, options.queueId]), kind === 'audio' ? music() : { data: Buffer.from('mp4'), type: 'video/mp4' }),
    complete: async () => {},
  };
}

function withCard(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zkads-media-'));
    try {
      writeJson(join(dir, 'concept.json'), sampleConcept());
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'makeMedia by default takes the sound from the orbit, steered by the music idea, and buys no music',
  withCard(async (dir) => {
    const steps = [];
    const venice = fakeVenice();
    await makeMedia({ venice, dir, models: MODELS, seconds: 8, progress: async (step) => steps.push(step) });
    assert.deepEqual(steps, ['image', 'orbit']);
    assert.deepEqual(venice.paid(), [['generateImage'], ['queue', 'video']]);
    const run = readRun(dir);
    assert.match(run.video.prompt, /Sound: .*Instrumental only/s);
    assert.equal(run.video.sound, true);
    assert.equal(run.music, undefined);
  }),
);

test(
  'makeMedia buys the image, orbit and music once, then a rerun buys nothing',
  withCard(async (dir) => {
    const steps = [];
    const venice = fakeVenice();
    await makeMedia({ venice, dir, models: MODELS, seconds: 8, sound: 'music', progress: async (step) => steps.push(step) });
    assert.deepEqual(steps, ['image', 'orbit', 'music']);
    assert.deepEqual(venice.paid(), [['generateImage'], ['queue', 'video'], ['queue', 'audio']]);
    for (const file of ['hero.png', 'orbit.mp4', 'music.m4a']) assert.ok(existsSync(join(dir, file)), file);

    const again = fakeVenice();
    const rerunSteps = [];
    await makeMedia({ venice: again, dir, models: MODELS, seconds: 8, sound: 'music', progress: async (step) => rerunSteps.push(step) });
    assert.doesNotMatch(readRun(dir).video.prompt, /Sound:/, 'with a music model, the orbit is not asked for sound');
    assert.deepEqual(again.calls, []);
    assert.deepEqual(rerunSteps, []);
  }),
);

test(
  'makeMedia collects an orbit that was paid for but not downloaded instead of buying another',
  withCard(async (dir) => {
    writeFileSync(join(dir, 'hero.png'), 'png');
    updateRun(dir, { image: { model: 'img-1' }, video: { model: MODELS.video, status: 'queued', queue_id: 'paid-7', duration: '8s' } });
    const venice = fakeVenice();
    await makeMedia({ venice, dir, models: MODELS, seconds: 8, sound: 'music' });
    assert.deepEqual(venice.paid(), [['queue', 'audio']]);
    assert.deepEqual(venice.calls.find(([name, kind]) => name === 'waitFor' && kind === 'video'), ['waitFor', 'video', 'paid-7']);
    assert.equal(readRun(dir).video.status, 'done');
  }),
);

test(
  'makeMedia finishes without music when the music job fails',
  withCard(async (dir) => {
    const logged = [];
    const venice = fakeVenice({ music: async () => Promise.reject(new VeniceError('music model unavailable', 500)) });
    await makeMedia({ venice, dir, models: MODELS, seconds: 8, sound: 'music', log: (line) => logged.push(line) });
    assert.ok(existsSync(join(dir, 'orbit.mp4')));
    assert.ok(logged.some((line) => line.startsWith('music failed')));
  }),
);

test(
  'makeMedia stops before paying when progress says the job was cancelled',
  withCard(async (dir) => {
    const venice = fakeVenice();
    const cancelled = Object.assign(new Error('cancelled'), { cancelled: true });
    await assert.rejects(makeMedia({ venice, dir, models: MODELS, seconds: 8, progress: async () => Promise.reject(cancelled) }), cancelled);
    assert.deepEqual(venice.calls, []);
  }),
);
