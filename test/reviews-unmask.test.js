import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVocab, unmaskText, unmaskerFor } from '../src/reviews/unmask.js';
import { klaviyoRows } from '../src/klaviyo/reviews.js';

// A small corpus in the way buyers write; each phrase the tests guess appears at least once.
const CORPUS = [
  'cocok banget buat saya', 'sangat cocok', 'cocok di badan', 'tidak cocok di lambung',
  'rasanya cukup enak', 'cukup membantu', 'harga cukup mahal',
  'buat ibu saya yang darah tinggi', 'darah tinggi turun', 'tekanan darah stabil',
  'yang jelas untuk saya enak', 'jelas ada efek', 'untuk tidur bagus',
  'ini pembelian ketiga yang paling cepat', 'ketiga kalinya order', 'yang kedua juga',
  'semoga saya cepat sehat', 'saya bisa tidur', 'semoga cocok', 'katanya bagus untuk sendi',
  'kami ya kak', 'kalinya beli', 'kalinya beli lagi',
  'masih ada *** di teks ini, jadi tidak dihitung',
];
const vocab = buildVocab(CORPUS);

test('words starred inside a word come back whole, the buyer’s capital kept', () => {
  assert.equal(unmaskText('tidak co***', vocab), 'tidak cocok');
  assert.equal(unmaskText('Co***', vocab), 'Cocok');
  assert.equal(unmaskText('rasanya ***up berkhasiat', vocab), 'rasanya cukup berkhasiat');
});

test('a stretch starred across a space comes back as the two words', () => {
  assert.equal(unmaskText('tekanan dara****nggi', vocab), 'tekanan darah tinggi');
  assert.equal(unmaskText('yg jel****ntuk saya', vocab), 'yg jelas untuk saya');
  assert.equal(unmaskText('kaleng keti****ang saya beli', vocab), 'kaleng ketiga yang saya beli');
  assert.equal(unmaskText('semo*****ya bisa', vocab), 'semoga saya bisa');
});

test('one word that fits beats two that happen to, when the neighbours agree', () => {
  assert.equal(unmaskText('karena ka***** bagus', vocab), 'karena katanya bagus');
});

test('what cannot be guessed stays as the marketplace sent it', () => {
  assert.equal(unmaskText('***', vocab), '***', 'nothing left visible');
  assert.equal(unmaskText('beli via ********* tidak dapat', vocab), 'beli via ********* tidak dapat');
  assert.equal(unmaskText('zz***qq', vocab), 'zz***qq', 'no word buyers wrote fits');
  assert.equal(unmaskText('tanpa sensor', vocab), 'tanpa sensor');
  assert.equal(unmaskText('', vocab), '');
});

test('a starred text never teaches the guesser', () => {
  assert.equal(buildVocab(['ada *** disini']).unigrams.size, 0);
});

test('the Klaviyo file carries the guessed words; without an unmasker it carries the text as sent', () => {
  const reviews = [
    { id: '1', channel: 'tokopedia', rating: 1, text: 'tidak co***', reviewerId: '17976429', reviewerName: 'tri', createdAt: '2026-11-12T14:31:39.000Z' },
    ...CORPUS.map((text, i) => ({ id: `c${i}`, channel: 'shopee', rating: 5, text, reviewerName: `b${i}`, createdAt: '2026-11-01T00:00:00.000Z' })),
  ];
  const unmask = unmaskerFor(reviews);
  assert.equal(klaviyoRows(reviews.slice(0, 1), { unmask })[0].review_content, 'tidak cocok');
  assert.equal(klaviyoRows(reviews.slice(0, 1))[0].review_content, 'tidak co***');
});
