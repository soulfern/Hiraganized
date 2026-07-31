const KANJI_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const KANJI_CHARACTER_PATTERN = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/u;
const KANJI_SEQUENCE_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{2,}/g;

const KANJI_TIMEOUT_MS = 3000;
const COMPOUND_TIMEOUT_MS = 8000;

const EMPTY_RESULT = {
  found: false,
  meanings: ['Lookup failed'],
  onyomi: [], kunyomi: [], jlpt: null, grade: null,
  strokes: null, radical: null, frequency: null
};

function unicodeOf(character) {
  return character ? `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : '';
}

function emptyFor(character) {
  return { character, unicode: unicodeOf(character), ...EMPTY_RESULT };
}

/**
 * Online-only kanji/compound lookup. No bundled dictionary and no persistence:
 * every lookup goes to the network. The only local state is in-flight request
 * dedup, so identical concurrent lookups within a single capture share one fetch.
 */
class DictionaryService {
  constructor() {
    this._pending = new Map(); // key -> in-flight promise (dedup only, cleared on settle)
  }

  _track(key, promise) {
    this._pending.set(key, promise);
    promise.finally(() => {
      // Only clear if this exact promise is still the tracked one.
      if (this._pending.get(key) === promise) this._pending.delete(key);
    }).catch(() => {});
    return promise;
  }

  async lookup(character) {
    const value = String(character || '').slice(0, 1);
    if (!value) return emptyFor('');
    if (!KANJI_CHARACTER_PATTERN.test(value)) return emptyFor(value);

    // Dedupe identical concurrent requests (e.g. same char from a compound + the char loop).
    const inflight = this._pending.get(value);
    if (inflight) return inflight;

    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), KANJI_TIMEOUT_MS);
      try {
        const response = await fetch(`https://kanjiapi.dev/v1/kanji/${encodeURIComponent(value)}`, {
          signal: controller.signal
        });
        if (response.ok) {
          const data = await response.json();
          return {
            character: data.kanji || value,
            unicode: unicodeOf(value),
            found: true,
            meanings: Array.isArray(data.meanings) ? data.meanings : [],
            onyomi: Array.isArray(data.on_readings) ? data.on_readings : [],
            kunyomi: Array.isArray(data.kun_readings) ? data.kun_readings : [],
            jlpt: data.jlpt ? `N${data.jlpt}` : null,
            grade: data.grade ?? null,
            strokes: data.stroke_count ?? null,
            radical: data.radical?.character || null,
            frequency: null
          };
        }
      } catch {} finally {
        clearTimeout(timeout);
      }
      return emptyFor(value);
    })();
    return this._track(value, promise);
  }

  async lookupCompound(word) {
    if (!word || word.length < 2) return this.lookup(word);
    if (!KANJI_CHARACTER_PATTERN.test(word[0])) return null;

    const inflight = this._pending.get(word);
    if (inflight) return inflight;

    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), COMPOUND_TIMEOUT_MS);
      try {
        const response = await fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Hiraganized/1.0' }
        });
        if (response.ok) {
          const data = await response.json();
          const match = (data.data || []).find((w) => w.japanese?.[0]?.word === word);
          if (match) {
            const jp = match.japanese[0];
            const senses = match.senses || [];
            const meanings = senses
              .flatMap((s) => s.english_definitions || [])
              .filter((m, i, a) => a.indexOf(m) === i);
            return {
              character: word,
              isCompound: true,
              found: true,
              readings: jp.reading ? [jp.reading] : [],
              meanings: meanings.slice(0, 5),
              onyomi: [], kunyomi: []
            };
          }
        }
      } catch {} finally {
        clearTimeout(timeout);
      }

      // Fallback: compose from per-character lookups (parallel, no serial chain).
      const chars = (await Promise.all([...word].map((c) => this.lookup(c)))).filter((c) => c && c.found);
      const allReadings = chars.flatMap((c) => [...(c.onyomi || []), ...(c.kunyomi || [])]);
      const allMeanings = chars.flatMap((c) => c.meanings || []);
      return {
        character: word,
        isCompound: true,
        found: true,
        readings: [...new Set(allReadings)].slice(0, 6),
        meanings: allMeanings.length ? [...new Set(allMeanings)].slice(0, 5) : [],
        onyomi: [], kunyomi: []
      };
    })();
    return this._track(word, promise);
  }

  extractSequences(text) {
    return String(text || '').match(KANJI_SEQUENCE_PATTERN) || [];
  }

  extractKanji(text) {
    return [...new Set(String(text || '').match(KANJI_PATTERN) || [])];
  }
}

module.exports = { DictionaryService, KANJI_PATTERN };
