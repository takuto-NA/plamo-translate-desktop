// Tests extension/cache.js: what a translation is kept under (`keyOf`), and which of the
// translations kept are removed (`evict`). The store itself needs a browser's IndexedDB.
//
// usage: node tests/extension/cache.test.mjs
import { createRequire } from "node:module";

const { evict, keyOf, MAX_CHARS, MAX_AGE_MS } = createRequire(import.meta.url)("../../extension/cache.js");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

const base = { engine: "app", model: "2B · Q4_K_M", target: "ja", style: "", text: "Hello, world." };
const key = await keyOf(base);
check("a key is a SHA-256 hash in hex", /^[0-9a-f]{64}$/.test(key), true);
check("the same text with the same settings has the same key", await keyOf({ ...base }), key);
check("no style and an empty one are the same", await keyOf({ ...base, style: undefined }), key);
for (const [name, other] of [
  ["text", { text: "Hello, world!" }],
  ["target language", { target: "en" }],
  ["style", { style: "polite" }],
  ["model", { model: "8B · Q4_K_M" }],
  ["engine", { engine: "browser" }],
]) {
  check(`another ${name} has another key`, (await keyOf({ ...base, ...other })) !== key, true);
}
// The parts do not run into one another.
check("the parts are kept apart", (await keyOf({ ...base, target: "j", style: "a" })) !== (await keyOf({ ...base, target: "ja", style: "" })), true);

const NOW = 1e12;
/** An entry of `size` characters used `ago` milliseconds ago. */
const entry = (key, ago, size = 1000) => ({ key, used: NOW - ago, size });

check("nothing to remove", evict([entry("a", 1000), entry("b", 2000)], NOW), []);
check("one not used for long goes", evict([entry("new", 1000), entry("stale", MAX_AGE_MS + 1000)], NOW), ["stale"]);
check(
  "past the limit together, the least recently used go",
  evict([entry("old", 3000, MAX_CHARS / 2), entry("new", 1000, MAX_CHARS / 2), entry("mid", 2000, MAX_CHARS / 2)], NOW),
  ["old"],
);
check("exactly at the limit, all stay", evict([entry("a", 1000, MAX_CHARS / 2), entry("b", 2000, MAX_CHARS / 2)], NOW), []);
check(
  "the order given does not matter",
  evict([entry("c", 3000, MAX_CHARS), entry("a", 1000, MAX_CHARS), entry("b", 2000, MAX_CHARS)], NOW),
  ["b", "c"],
);

console.log(failures ? `${failures} failed` : "all ok");
process.exit(failures ? 1 : 0);
