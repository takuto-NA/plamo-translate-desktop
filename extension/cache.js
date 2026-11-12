// Keeps translations in the browser (IndexedDB), so that text translated before is not
// translated again: a page loaded again, the extension's PDF viewer reopened, the same selection.
// The background asks here before it sends anything to the engine (see background.js).
//
// A translation is kept under the hash of what it was made from and with: the engine and its
// model, the target language, the style, and the text. Only the hash is kept of those, with the
// translation, its size, and when it was last used. The least recently used go when the cache
// grows past its limit (see `evict`).
//
// Loaded as a plain script by the background (importScripts), and by the tests
// (tests/extension/cache.test.mjs) for `evict` and `keyOf`.

var translationCache = (() => {
  const NAME = "translations";
  /** Characters kept at most, of the texts and their translations together. */
  const MAX_CHARS = 8_000_000;
  /** Not used for this long: removed. */
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  /** A longer text (with its translation) is not kept. */
  const MAX_ENTRY_CHARS = 200_000;
  /** A use is noted again only after this long, to spare writes. */
  const TOUCH_MS = 60 * 60 * 1000;
  /** The cache is checked against its limits after this many translations are added. */
  const PRUNE_EVERY = 200;

  /**
   * The key of a translation: the hash of the engine (`app` or `browser`), its model, the
   * target language (as asked for: `auto` too), the style, and the text.
   */
  async function keyOf({ engine, model, target, style, text }) {
    const bytes = new TextEncoder().encode(JSON.stringify([engine, model, target, style || "", text]));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * The keys of the entries to remove, of `entries` ({ key, used, size }): those not used for
   * MAX_AGE_MS, and of the rest the least recently used past MAX_CHARS together.
   */
  function evict(entries, now) {
    const out = [];
    let chars = 0;
    for (const entry of [...entries].sort((a, b) => b.used - a.used)) {
      chars += entry.size;
      if (now - entry.used > MAX_AGE_MS || chars > MAX_CHARS) out.push(entry.key);
    }
    return out;
  }

  let opening = null;
  function open() {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
    });
    return opening;
  }

  /** Runs `work(store)` in one transaction; resolves with its result once it is committed. */
  async function transact(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["entries"], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
      result = work(tx.objectStore("entries"));
    });
  }

  /**
   * The translations kept for `keys`: a Map from key to { text, target } (`target` is the
   * language a translation into `auto` went into). Counts as using them.
   */
  function get(keys) {
    const found = new Map();
    const now = Date.now();
    return transact("readwrite", (store) => {
      for (const key of new Set(keys)) {
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) return;
          found.set(key, { text: entry.text, target: entry.target });
          if (now - entry.used > TOUCH_MS) store.put({ ...entry, used: now });
        };
      }
      return found;
    });
  }

  let added = 0;
  /**
   * Keeps translations: `entries` are { key, text, target, size }, where `size` is the length
   * of the text translated and of its translation together.
   */
  async function put(entries) {
    entries = entries.filter((entry) => entry.size <= MAX_ENTRY_CHARS);
    if (!entries.length) return;
    const used = Date.now();
    await transact("readwrite", (store) => {
      for (const { key, text, target, size } of entries) store.put({ key, text, target, size, used });
    });
    added += entries.length;
    if (added >= PRUNE_EVERY) await prune();
  }

  /** Removes what `evict` names. */
  async function prune() {
    added = 0;
    const db = await open();
    const all = await new Promise((resolve, reject) => {
      const entries = [];
      // Without the translations themselves: only what `evict` goes by.
      const request = db.transaction(["entries"]).objectStore("entries").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(entries);
        entries.push({ key: cursor.value.key, used: cursor.value.used, size: cursor.value.size });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    const keys = evict(all, Date.now());
    if (!keys.length) return;
    await transact("readwrite", (store) => {
      for (const key of keys) store.delete(key);
    });
  }

  function clear() {
    added = 0;
    return transact("readwrite", (store) => {
      store.clear();
    });
  }

  /** How many translations are kept. */
  async function count() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(["entries"]).objectStore("entries").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return { MAX_CHARS, MAX_AGE_MS, MAX_ENTRY_CHARS, keyOf, evict, get, put, prune, clear, count };
})();

if (typeof module === "object") module.exports = translationCache;
