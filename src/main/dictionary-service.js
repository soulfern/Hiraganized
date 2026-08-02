const fs = require('node:fs');
const path = require('node:path');

const KANJI_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const KANJI_CHARACTER_PATTERN = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/u;
const KANJI_SEQUENCE_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{2,}/g;

const KANJI_TIMEOUT_MS = 3000;
const COMPOUND_TIMEOUT_MS = 4000;
const PERSIST_DEBOUNCE_MS = 2000;

const SEGMENT_LOOKUP_BUDGET = 12;

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

class DictionaryService {
  constructor(cachePath) {
    this._pending = new Map();

    this._cache = new Map();

    this._cachePath = cachePath || null;
    this._dirty = false;
    this._persistTimer = null;
    this._epoch = 0;

  }


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
    } catch {  }
    return this;
  }

  _cacheResult(key, result) {


    if (!result || result.found !== true) return;
    this._cache.set(key, result);
    this._dirty = true;
    if (this._cachePath && !this._persistTimer) {
      this._persistTimer = setTimeout(() => this._flush(), PERSIST_DEBOUNCE_MS);
    }
  }


  _staleEpoch(epoch) {
    return epoch !== this._epoch;
  }

  _flush() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (!this._cachePath || !this._dirty) return;
    try {


      const obj = {};
      for (const [key, value] of this._cache) {
        if (!value || value.__notWord) continue;
        const { _children, ...entry } = value;
        obj[key] = entry;
      }
      const tmp = `${this._cachePath}.${process.pid}.${Date.now()}.tmp`;
      fs.mkdirSync(path.dirname(this._cachePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, this._cachePath);
      this._dirty = false;
    } catch {  }
  }


  flush() {
    this._flush();
  }


  clearCache() {
    this._epoch += 1;
    this._cache.clear();
    this._pending.clear();
    this._dirty = false;
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    try {
      if (this._cachePath) fs.rmSync(this._cachePath, { force: true });
    } catch {  }
  }

  _track(key, promise) {
    this._pending.set(key, promise);
    promise.finally(() => {


      if (this._pending.get(key) === promise) this._pending.delete(key);
    }).catch(() => {});
    return promise;
  }

  async lookup(character) {
    const value = String(character || '').slice(0, 1);
    if (!value) return emptyFor('');
    if (!KANJI_CHARACTER_PATTERN.test(value)) return emptyFor(value);



    const cached = this._cache.get(value);
    if (cached) return { ...cached, character: value };



    const inflight = this._pending.get(value);
    if (inflight) return inflight;

    const epoch = this._epoch;
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
            character: value,
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
          if (!this._staleEpoch(epoch)) this._cacheResult(value, result);
          return { ...result };
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







    const cacheKey = `#${word}`;
    if (this._cache.has(cacheKey)) {
      const hit = this._cache.get(cacheKey);
      if (hit && hit.__notWord) return null;
      return hit ? { ...hit, character: word } : null;
    }

    const inflight = this._pending.get(cacheKey);
    if (inflight) return inflight;

    const epoch = this._epoch;
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
          const match = (data.data || []).find((w) =>
            (w.japanese || []).some((jp) => jp && jp.word === word)
          );
          if (match) {
            const jp = (match.japanese || []).find((j) => j && j.word === word) || (match.japanese || [])[0];
            const senses = match.senses || [];
            const meanings = senses
              .flatMap((s) => s.english_definitions || [])
              .filter((m, i, a) => a.indexOf(m) === i);
            const result = {
              character: word,
              isCompound: true,
              found: true,
              readings: jp && jp.reading ? [jp.reading] : [],
              meanings: meanings.slice(0, 5),
              onyomi: [], kunyomi: []
            };
            if (!this._staleEpoch(epoch)) this._cacheResult(cacheKey, result);
            return { ...result };
          }






          this._cache.set(cacheKey, { __notWord: true });
        }
      } catch {} finally {
        clearTimeout(timeout);
      }









      if (!this._staleEpoch(epoch)) this._cache.set(cacheKey, { __notWord: true });
      return null;
    })();
    return this._track(cacheKey, promise);
  }


  async segmentSequence(run) {
    if (!run || run.length < 2) return [run].filter(Boolean);
    const pieces = [];
    let i = 0;
    let budget = SEGMENT_LOOKUP_BUDGET;
    const n = run.length;
    while (i < n) {


      let matched = null;
      for (let end = Math.min(n, i + 4); end > i; end--) {
        if (budget <= 0) break;

        budget -= 1;
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
