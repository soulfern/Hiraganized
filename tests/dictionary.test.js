const test = require('node:test');
const assert = require('node:assert/strict');
const { DictionaryService } = require('../src/main/dictionary-service');

test('dictionary extracts unique kanji from mixed text', () => {
  const service = new DictionaryService();
  assert.deepEqual(service.extractKanji('abc日本語def'), ['日', '本', '語']);
  assert.deepEqual(service.extractKanji('漢字abc漢字'), ['漢', '字']);
});

test('dictionary extracts kanji sequences', () => {
  const service = new DictionaryService();
  assert.deepEqual(service.extractSequences('abc日本語def'), ['日本語']);
  assert.deepEqual(service.extractSequences('勉強中です'), ['勉強中']);
});

test('lookup returns fallback for non-kanji input', async () => {
  const service = new DictionaryService();
  const result = await service.lookup('a');
  assert.equal(result.found, false);
  assert.equal(result.character, 'a');
});

test('lookup fetches from kanjiapi.dev on cache miss', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(url);
    if (url.includes('kanjiapi.dev/v1/kanji/%E6%97%A5')) {
      return {
        ok: true,
        json: async () => ({
          kanji: '日',
          meanings: ['day', 'sun'],
          on_readings: ['ニチ', 'ジツ'],
          kun_readings: ['ひ', 'か'],
          jlpt: 5,
          grade: 1,
          stroke_count: 4,
          radical: { character: '日' }
        })
      };
    }
    return { ok: false };
  };

  try {
    const service = new DictionaryService();
    const result = await service.lookup('日');
    assert.equal(result.found, true);
    assert.equal(result.character, '日');
    assert.ok(result.meanings.includes('day'));
    assert.ok(result.onyomi.includes('ニチ'));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('kanjiapi.dev'));
  } finally {
    global.fetch = originalFetch;
  }
});
