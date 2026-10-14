import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanBrand, cleanItem, cleanSponsor, FAKE_BRANDS, fitsFromCard, MIN_FIT, runAuction } from '../lib/brands.mjs';
import { sampleConcept } from './fixtures.mjs';

const brand = (id, bid, targets = ['ferns']) => ({ id, name: id, product: 'p', tagline: 't', targets, bid });

test('the auction is second-price on bid × fit, in whole credits', () => {
  // 10 × 28 beats 1 × 28; the winner pays the least bid that still beats 28: ceil(1 × 28 / 28) = 1.
  assert.deepEqual(runAuction([brand('a', 10), brand('b', 1)], { a: 28, b: 28 }).price, 1);
  // 20 × 40 = 800 beats 30 × 20 = 600; pays ceil(600 / 40) = 15.
  const won = runAuction([brand('a', 20), brand('b', 30)], { a: 40, b: 20 });
  assert.equal(won.brand.id, 'a');
  assert.equal(won.price, 15);
  // A tie goes to the lower id, which pays its own bid.
  const tie = runAuction([brand('b', 10), brand('a', 10)], { a: 40, b: 40 });
  assert.equal(tie.brand.id, 'a');
  assert.equal(tie.price, 10);
  // Bidding exactly the runner-up's score would lose that tie to a lower id, so it costs one more.
  assert.equal(runAuction([brand('b', 10), brand('a', 5)], { a: 40, b: 40 }).price, 6);
  assert.equal(runAuction([brand('a', 10), brand('b', 5)], { a: 40, b: 40 }).price, 5);
  // Alone, a brand pays 1; below the minimum fit nobody wins.
  assert.equal(runAuction([brand('a', 50)], { a: 80 }).price, 1);
  assert.equal(runAuction([brand('a', 50)], { a: MIN_FIT - 1 }), null);
});

test('fit comes from the card’s own text, in code, and nothing private', () => {
  const brands = [brand('ferns', 10, ['ferns', 'misting']), brand('boats', 10, ['sailing'])];
  const fits = fitsFromCard({ concept: sampleConcept(), tags: ['sailing', 'theremins'], brands });
  assert.equal(fits.ferns, 40, 'the card mentions misting ferns');
  assert.equal(fits.boats, 0, 'interest tags from a summary never count: the winner shows on a public page');
  assert.equal(fitsFromCard({ concept: sampleConcept(), brands: [brand('x', 10, ['zeppelins'])] }).x, 0);
  // A stored target too short or too common to mean anything never fits.
  assert.equal(fitsFromCard({ concept: { ...sampleConcept(), reading: 'One of a kind.' }, brands: [brand('of', 90, ['of', 'a'])] }).of, 0);
});

test('bids, items and sponsors are short plain text with sane numbers', () => {
  assert.deepEqual(cleanBrand({ name: ' Fern\u0000Fizz ', product: 'Tonic', tagline: 'Mist', targets: 'Ferns, , Chess', bid: 40 }), { name: 'Fern Fizz', product: 'Tonic', tagline: 'Mist', targets: ['ferns', 'chess'], bid: 40 });
  assert.throws(() => cleanBrand({ name: 'x', product: 'y', tagline: 'z', targets: 'tea', bid: 101 }), /bid/);
  assert.throws(() => cleanItem({ name: '', teaser: 't' }, sampleConcept()), /empty/);
  assert.equal(cleanSponsor({ brand: 'B', name: 'N', teaser: 'T', credits: 5000 }).credits, 0);
  assert.ok(FAKE_BRANDS.every((b) => cleanBrand(b)), 'every roster brand passes its own checks');
});

test('targets match whole words in the card’s values, never key names or punctuation', () => {
  const brands = [brand('everywhere', 90, ['era', 'product', 'traits', 'archetype']), brand('tea', 10, ['tea']), brand('ferns', 10, ['misting'])];
  const fits = fitsFromCard({ concept: sampleConcept(), brands });
  assert.equal(fits.everywhere, 0);
  assert.equal(fits.tea, 0, '"tea" is not inside "Terrarium"');
  assert.equal(fits.ferns, 40);
  assert.deepEqual(cleanBrand({ name: 'X', product: 'Y', tagline: 'Z', targets: 'null, ,, ab, the, Misting Ferns!', bid: 5 }).targets, ['misting ferns']);
});
