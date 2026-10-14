import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SLOP_CANNON } from '../app/example.js';
import { INTRO_PROMPT } from '../app/intro-prompt.js';

test('About copies the public intro prompt word for word', () => {
  assert.equal(INTRO_PROMPT, readFileSync(new URL('../design/charlie-overlap-prompt.txt', import.meta.url), 'utf8').trimEnd());
  assert.match(INTRO_PROMPT, /^Twitter: https:\/\/x\.com\/charlie______t$/m, 'six underscores, as linked from the website');
});

test('the landing page’s example tells the story of its own concept', () => {
  const concept = JSON.parse(readFileSync(new URL('../examples/slop-cannon/concept.json', import.meta.url), 'utf8'));
  for (const [key, value] of Object.entries(SLOP_CANNON)) assert.deepEqual(value, concept[key], key);
  assert.equal(Object.keys(SLOP_CANNON).length, 13);
});
