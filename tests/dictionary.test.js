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

test('lookup serves a repeat lookup from cache without a second fetch', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ kanji: '水', meanings: ['water'], on_readings: ['スイ'], kun_readings: ['みず'] }) };
  };
  try {
    const service = new DictionaryService();
    const first = await service.lookup('水');
    const second = await service.lookup('水');
    assert.equal(first.found, true);
    assert.equal(second.found, true);
    assert.equal(calls, 1, 'second lookup should hit the in-memory cache');
  } finally {
    global.fetch = originalFetch;
  }
});

test('cache persists to disk and reloads without network', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const originalFetch = global.fetch;
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hira-dict-')), 'cache.json');
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ kanji: '火', meanings: ['fire'], on_readings: ['カ'], kun_readings: ['ひ'] }) };
  };
  try {
    const s1 = new DictionaryService(cachePath).load();
    await s1.lookup('火');
    s1.flush();
    assert.ok(fs.existsSync(cachePath), 'cache file should be written on flush');

    calls = 0;
    const s2 = new DictionaryService(cachePath).load();
    const reloaded = await s2.lookup('火');
    assert.equal(reloaded.found, true);
    assert.ok(reloaded.meanings.includes('fire'));
    assert.equal(calls, 0, 'reloaded cache should serve without any network call');
  } finally {
    global.fetch = originalFetch;
    try { fs.rmSync(path.dirname(cachePath), { recursive: true, force: true }); } catch {}
  }
});

test('failed lookups are not cached', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 404 }; };
  try {
    const service = new DictionaryService();
    const first = await service.lookup('日');
    const second = await service.lookup('日');
    assert.equal(first.found, false);
    assert.equal(second.found, false);
    assert.equal(calls, 2, 'a failed lookup must not be cached and should re-fetch');
  } finally {
    global.fetch = originalFetch;
  }
});
