import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, similarity, tokenize } from '../src/similarity.js';

test('tokenize drops filler words, stems, and adds bigrams', () => {
  const t = tokenize('Proving the theorem using continued fractions');
  assert.ok(t.includes('theorem'));
  assert.ok(t.includes('fraction'));
  assert.ok(t.includes('continu_fraction'));
  assert.ok(!t.includes('the'));
});

test('the same idea in other words scores far above a different idea', () => {
  const a = 'Assume the fraction is in lowest terms and derive a parity contradiction: numerator and denominator are both even.';
  const b = 'Parity contradiction. Assume lowest terms, then show that numerator and denominator are both even.';
  const c = 'Compute the continued fraction expansion and prove that it never terminates.';
  assert.ok(similarity(a, b) > 0.45, `same idea: ${similarity(a, b)}`);
  assert.ok(similarity(a, c) < 0.2, `different idea: ${similarity(a, c)}`);
  assert.equal(similarity('', a), 0);
});

test('rank orders documents best first', () => {
  const docs = [
    { id: 'cf', text: 'Continued fraction expansion never terminates' },
    { id: 'parity', text: 'Parity argument: both numerator and denominator even' },
    { id: 'descent', text: 'Infinite descent on the denominator' },
  ];
  assert.equal(rank('a parity contradiction with even numerator', docs)[0].id, 'parity');
  assert.deepEqual(rank('anything', []), []);
});
