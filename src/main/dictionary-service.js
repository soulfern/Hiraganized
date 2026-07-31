const fs = require('node:fs');
const path = require('node:path');

const KANJI_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const KANJI_CHARACTER_PATTERN = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/u;
const KANJI_SEQUENCE_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{2,}/g;

const KANJI_TIMEOUT_MS = 3000;
const COMPOUND_TIMEOUT_MS = 8000;
const PERSIST_DEBOUNCE_MS = 2000;

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
 * Online kanji/compound lookup with a local write-through cache. The first
 * lookup of a character or compound fetches from the network; the successful
 * result is kept in memory and persisted to disk (debounced), so subsequent
 * lookups — this session or future ones — resolve instantly and offline.
 * In-flight dedup ensures identical concurrent lookups share one fetch.
 */
class DictionaryService {
  constructor(cachePath) {
    this._pending = new Map();   // key -> in-flight promise (dedup, cleared on settle)
    this._cache = new Map();     // key -> resolved result (found entries only)
    this._cachePath = cachePath || null;
    this._dirty = false;
    this._persistTimer = null;
  }

  /** Load any previously persisted cache from disk. Safe to call once at startup. */
  load(cachePath) {
    if (cachePath) this._cachePath = cachePath;
    if (!this._cachePath) return this;
    try {
      if (fs.existsSync(this._cachePath)) {
        const data = JSON.parse(fs.readFileSync(this._cachePath, 'utf8'));
        if (data && typeof data === 'object') {
          for (const [key, entry] of Object.entries(data)) {
            if (entry && typeof entry === 'object') this._cache.set(key, entry);
          }
        }
      }
    } catch { /* corrupt cache is non-fatal — we just re-fetch */ }
    return this;
  }

  _cacheResult(key, result) {
    // Only persist genuine hits — never cache failures/placeholders.
    if (!result || result.found !== true) return;
    this._cache.set(key, result);
    this._dirty = true;
    if (this._cachePath && !this._persistTimer) {
      this._persistTimer = setTimeout(() => this._flush(), PERSIST_DEBOUNCE_MS);
    }
  }

  _flush() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (!this._cachePath || !this._dirty) return;
    try {
      // Persist genuine hits only — never the in-memory "not a word" markers.
      const obj = {};
      for (const [key, value] of this._cache) {
        if (value && value.__notWord) continue;
        obj[key] = value;
      }
      const tmp = `${this._cachePath}.${process.pid}.${Date.now()}.tmp`;
      fs.mkdirSync(path.dirname(this._cachePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, this._cachePath);
      this._dirty = false;
    } catch { /* best-effort; will retry on next cache write */ }
  }

  /** Persist immediately (call on app quit to flush any pending debounce). */
  flush() {
    this._flush();
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

    // 1. Local cache (instant, offline).
    const cached = this._cache.get(value);
    if (cached) return cached;

    // 2. Dedupe identical concurrent requests (same char from a compound + the char loop).
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
          const result = {
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
          this._cacheResult(value, result);
          return result;
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

    // Compound cache keys are prefixed so a compound never collides with a
    // single-kanji entry. `null` (confirmed non-word) is cached too, to avoid
    // re-querying Jisho for the same non-word during segmentation.
    const cacheKey = `#${word}`;
    if (this._cache.has(cacheKey)) {
      const hit = this._cache.get(cacheKey);
      return hit && hit.__notWord ? null : hit;
    }

    const inflight = this._pending.get(cacheKey);
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
            const result = {
              character: word,
              isCompound: true,
              found: true,
              readings: jp.reading ? [jp.reading] : [],
              meanings: meanings.slice(0, 5),
              onyomi: [], kunyomi: []
            };
            this._cacheResult(cacheKey, result);
            return result;
          }
          // Confirmed reachable-but-not-a-word: remember in-memory only (not
          // persisted — avoids disk bloat and permanent staleness if Jisho later
          // adds the word) so segmentation doesn't re-query it this session.
          this._cache.set(cacheKey, { __notWord: true });
        }
      } catch {} finally {
        clearTimeout(timeout);
      }

      // Network failure or not a real compound → return null so the caller can
      // try segmentation or individual chars. (Transient failures are not cached.)
      return null;
    })();
    return this._track(cacheKey, promise);
  }

  /**
   * Greedily split a kanji run into real compounds + leftover chars.
   * e.g. "毎日日本語" -> ["毎日", "日本語"] (both real words), then callers
   * fall back to individual chars for anything else.
   */
  async segmentSequence(run) {
    if (!run || run.length < 2) return [run].filter(Boolean);
    const pieces = [];
    let i = 0;
    const n = run.length;
    while (i < n) {
      // Longest-first: try to match a real compound ending at each index.
      let matched = null;
      for (let end = Math.min(n, i + 4); end > i; end--) {
        const candidate = run.slice(i, end);
        if (await this.lookupCompound(candidate)) {
          matched = { candidate, end };
          break;
        }
      }
      if (matched) {
        pieces.push(matched.candidate);
        i = matched.end;
      } else {
        // No compound from here — advance one char (it gets its own entry later).
        i += 1;
      }
    }
    return pieces;
  }

  extractSequences(text) {
    return String(text || '').match(KANJI_SEQUENCE_PATTERN) || [];
  }

  extractKanji(text) {
    return [...new Set(String(text || '').match(KANJI_PATTERN) || [])];
  }
}

module.exports = { DictionaryService, KANJI_PATTERN };
