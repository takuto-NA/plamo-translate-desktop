// Tests extension/auto-target.js: which language the `auto` target means for a text.
//
// usage: node tests/extension/auto-target.test.mjs
import { createRequire } from "node:module";

const resolveTarget = createRequire(import.meta.url)("../../extension/auto-target.js");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

check(
  "kana means Japanese, kanji alone does not, and a language asked for stays",
  [resolveTarget("auto", "こんにちは"), resolveTarget("auto", "漢字"), resolveTarget("auto", "Hello"), resolveTarget("fr", "こんにちは"), resolveTarget(undefined, "Hello")],
  ["en", "ja", "ja", "fr", "ja"],
);
check(
  "by the share of Japanese letters",
  [
    resolveTarget("auto", "Rust と GPUI で実装する"),
    resolveTarget("auto", "npm install --save-dev typescript を実行"),
    resolveTarget("auto", 'The first example translates a text into English: translate --to en "こんにちは"'),
  ],
  ["en", "en", "ja"],
);

console.log(failures ? `${failures} failed` : "all ok");
process.exit(failures ? 1 : 0);
