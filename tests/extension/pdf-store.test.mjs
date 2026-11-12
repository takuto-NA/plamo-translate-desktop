// Tests extension/pdf-store.js: which of the PDFs kept for the viewer are removed (`evict`).
// The store itself needs a browser's IndexedDB.
//
// usage: node tests/extension/pdf-store.test.mjs
import { createRequire } from "node:module";

const { evict, MAX_FILES, MAX_BYTES, MAX_AGE_MS, INCOMPLETE_MS } = createRequire(import.meta.url)("../../extension/pdf-store.js");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

const NOW = 1e12;
const MB = 1024 * 1024;
/** A complete file opened `ago` milliseconds ago. */
const file = (key, ago, size = MB, complete = true) => ({ key, opened: NOW - ago, size, complete });

check("nothing to remove", evict([file("a", 1000), file("b", 2000)], NOW), []);
check(
  "only the last files opened stay",
  evict(Array.from({ length: MAX_FILES + 2 }, (_, i) => file(`f${i}`, i * 1000)).reverse(), NOW),
  [`f${MAX_FILES}`, `f${MAX_FILES + 1}`],
);
check(
  "files past the size together go, the oldest first",
  evict([file("new", 1000, MAX_BYTES / 2), file("mid", 2000, MAX_BYTES / 2), file("old", 3000, MB)], NOW),
  ["old"],
);
check("the last file opened stays whatever its size", evict([file("huge", 1000, 2 * MAX_BYTES), file("old", 2000)], NOW), ["old"]);
check("a file not opened for long goes", evict([file("new", 1000), file("stale", MAX_AGE_MS + 1000)], NOW), ["stale"]);
check(
  "a file being written stays and does not count; one left incomplete goes",
  evict([file("writing", 1000, 0, false), file("broken", INCOMPLETE_MS + 1000, 0, false), ...Array.from({ length: MAX_FILES }, (_, i) => file(`f${i}`, 2000 + i))], NOW),
  ["broken"],
);

console.log(failures ? `${failures} failed` : "all ok");
process.exit(failures ? 1 : 0);
