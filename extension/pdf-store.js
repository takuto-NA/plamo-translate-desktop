// Keeps the PDFs of the extension's viewer (pdf.html) and their translations in the browser
// (IndexedDB), so that a viewer reloaded, or restored with the browser, shows its PDF again
// with what was translated. Only the PDFs opened last are kept (see `evict`).
//
// Loaded as a plain script by the background (importScripts) and by pdf.html, and by the tests
// (tests/extension/pdf-store.test.mjs) for `evict`.
//
// - `files`: { key, url, opened, complete, size, chunks } by key (the viewer's `key`).
// - `chunks`: the file's bytes in pieces (ArrayBuffer), by [key, index]. The background gets
//   them one by one from the tab the PDF was open in.
// - `translations`: { source, lang, style, parts } by [key, page, index]: the paragraph `index`
//   of `page`, whose text was `source`, translated into `lang` in `style` (the panel's
//   settings). `parts` are strings and numbers, a number for the paragraph's formula of that
//   index; or null where the translation was the text itself, which is not asked for again.

var pdfStore = (() => {
  const NAME = "pdf";
  /** PDFs kept at most, the last ones opened. */
  const MAX_FILES = 5;
  /** Their size at most together; the last one opened is kept whatever its size. */
  const MAX_BYTES = 256 * 1024 * 1024;
  /** Not opened for this long: removed. */
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  /** A file not complete after this long is left over from a failure. */
  const INCOMPLETE_MS = 10 * 60 * 1000;

  /**
   * The keys of the files to remove, of `files` (as in the store): all but the last MAX_FILES
   * opened, those past MAX_BYTES together, those not opened for MAX_AGE_MS, and files left
   * incomplete. Incomplete files being written count toward neither limit.
   */
  function evict(files, now) {
    const out = [];
    const kept = [];
    for (const file of [...files].sort((a, b) => b.opened - a.opened)) {
      if (!file.complete) {
        if (now - file.opened > INCOMPLETE_MS) out.push(file.key);
      } else if (now - file.opened > MAX_AGE_MS) {
        out.push(file.key);
      } else {
        kept.push(file);
      }
    }
    let bytes = 0;
    kept.forEach((file, i) => {
      bytes += file.size ?? 0;
      if (i > 0 && (i >= MAX_FILES || bytes > MAX_BYTES)) out.push(file.key);
    });
    return out;
  }

  let opening = null;
  function open() {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("files", { keyPath: "key" });
        db.createObjectStore("chunks");
        db.createObjectStore("translations");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
    });
    return opening;
  }

  /** Runs `work(stores…)` in one transaction; resolves with its result once it is committed. */
  async function transact(names, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
      result = work(...names.map((name) => tx.objectStore(name)));
    });
  }

  const wait = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  /** Everything of `key`: [key, …] in the stores keyed by arrays. */
  const all = (key) => IDBKeyRange.bound([key], [key, []]);

  /** Starts the file `key`, read from `url`: its chunks follow, then `finish`. */
  function begin(key, url) {
    return transact(["files", "chunks"], "readwrite", (files, chunks) => {
      chunks.delete(all(key));
      files.put({ key, url, opened: Date.now(), complete: false, size: 0, chunks: 0 });
    });
  }

  function putChunk(key, index, buffer) {
    return transact(["chunks"], "readwrite", (chunks) => {
      chunks.put(buffer, [key, index]);
    });
  }

  /** The file is all there, in `chunks` chunks of `size` bytes together. Older files make room. */
  async function finish(key, size, chunks) {
    await transact(["files"], "readwrite", (files) => {
      const request = files.get(key);
      request.onsuccess = () => {
        if (request.result) files.put({ ...request.result, complete: true, size, chunks, opened: Date.now() });
      };
    });
    await prune();
  }

  /** Stores a whole file at once (the viewer, having read it from its address). */
  async function put(key, url, bytes) {
    const CHUNK = 8 * 1024 * 1024;
    await begin(key, url);
    let count = 0;
    for (let at = 0; at < bytes.length; at += CHUNK) await putChunk(key, count++, bytes.slice(at, at + CHUNK).buffer);
    await finish(key, bytes.length, count);
  }

  /**
   * The file `key`: { url, bytes (Uint8Array) }, or null if it is not kept (or not
   * whole). Counts as opening it.
   */
  async function get(key) {
    const db = await open();
    const tx = db.transaction(["files", "chunks"], "readwrite");
    const file = await wait(tx.objectStore("files").get(key));
    if (!file?.complete) return null;
    const parts = await wait(tx.objectStore("chunks").getAll(all(key)));
    if (parts.length !== file.chunks) return null;
    tx.objectStore("files").put({ ...file, opened: Date.now() });
    const bytes = new Uint8Array(file.size);
    let at = 0;
    for (const part of parts) {
      bytes.set(new Uint8Array(part), at);
      at += part.byteLength;
    }
    return { url: file.url, bytes };
  }

  /** The file's translations: a Map from "page:index" to { source, lang, style, parts }. */
  async function translations(key) {
    const db = await open();
    const store = db.transaction(["translations"]).objectStore("translations");
    const [keys, values] = await Promise.all([wait(store.getAllKeys(all(key))), wait(store.getAll(all(key)))]);
    return new Map(keys.map(([, page, index], i) => [`${page}:${index}`, values[i]]));
  }

  /** Keeps a paragraph's translation, if its file is kept. */
  function putTranslation(key, page, index, value) {
    return transact(["files", "translations"], "readwrite", (files, translations) => {
      const request = files.count(key);
      request.onsuccess = () => {
        if (request.result) translations.put(value, [key, page, index]);
      };
    });
  }

  function deleteTranslation(key, page, index) {
    return transact(["translations"], "readwrite", (translations) => {
      translations.delete([key, page, index]);
    });
  }

  function clearTranslations(key) {
    return transact(["translations"], "readwrite", (translations) => {
      translations.delete(all(key));
    });
  }

  /** Removes the file `key`, with its translations. */
  function remove(key) {
    return transact(["files", "chunks", "translations"], "readwrite", (files, chunks, translations) => {
      files.delete(key);
      chunks.delete(all(key));
      translations.delete(all(key));
    });
  }

  /** Removes the files `evict` names, with their translations. */
  async function prune() {
    const db = await open();
    const files = await wait(db.transaction(["files"]).objectStore("files").getAll());
    const keys = evict(files, Date.now());
    if (!keys.length) return;
    await transact(["files", "chunks", "translations"], "readwrite", (files, chunks, translations) => {
      for (const key of keys) {
        files.delete(key);
        chunks.delete(all(key));
        translations.delete(all(key));
      }
    });
  }

  return {
    MAX_FILES, MAX_BYTES, MAX_AGE_MS, INCOMPLETE_MS,
    evict, begin, putChunk, finish, put, get, translations, putTranslation, deleteTranslation, clearTranslations, remove, prune,
  };
})();

if (typeof module === "object") module.exports = pdfStore;
