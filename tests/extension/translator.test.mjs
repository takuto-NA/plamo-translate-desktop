// Tests extension/translator.js: the prompts against the app's (crates/pfml, whose expected
// strings come from the model card), the splitting of long texts, and the history.
//
// usage: node tests/extension/translator.test.mjs
import { History, STOP, escape, estimateTokens, prompt, resolveTarget, split } from "../../extension/translator.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

check(
  "basic",
  prompt({ text: "会議は来週の月曜日に変更されました。", target: "en" }),
  "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>会議は来週の月曜日に変更されました。" +
    "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>",
);
check(
  "history with the source language",
  prompt({
    text: "オーナーでフィルタリングすることもできます。",
    target: "en",
    source: "ja",
    history: [
      { source: "プロジェクトの管理画面を開きます。", translation: "Open the project dashboard." },
      { source: "進行中のタスクがすべて表示されます。", translation: "It lists all active tasks." },
    ],
  }),
  "<|plamo:tag|>dataset<|plamo:msg|>translation" +
    "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>プロジェクトの管理画面を開きます。" +
    "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Open the project dashboard." +
    "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>進行中のタスクがすべて表示されます。" +
    "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>It lists all active tasks." +
    "<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>オーナーでフィルタリングすることもできます。" +
    "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>",
);
for (const style of ["plain", "polite"]) {
  check(
    `form ${style}`,
    prompt({ text: "This system is convenient.", target: "ja", style }),
    "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>This system is convenient." +
      `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>${style}<|plamo:msg|>`,
  );
}
check("style only for Japanese", prompt({ text: "x", target: "en", style: "polite" }).includes("form"), false);
check("escape", escape("a <|plamo:tag|> b"), "a <​|plamo:tag|> b");
check("escaped in the prompt", prompt({ text: "<|plamo:msg|>", target: "en" }).split("<|plamo:msg|>").length, 4);
check("stop", STOP, "<|plamo:tag|>");
check(
  "auto",
  [resolveTarget("auto", "こんにちは"), resolveTarget("auto", "漢字"), resolveTarget("auto", "Hello"), resolveTarget("fr", "こんにちは")],
  ["en", "ja", "ja", "fr"],
);
check(
  "auto by the share of Japanese letters",
  [
    resolveTarget("auto", "Rust と GPUI で実装する"),
    resolveTarget("auto", "npm install --save-dev typescript を実行"),
    resolveTarget("auto", 'The first example translates a text into English: translate --to en "こんにちは"'),
  ],
  ["en", "en", "ja"],
);
check("estimate", [estimateTokens("abcdefgh"), estimateTokens("日本語"), estimateTokens("")], [2, 3, 0]);

const rebuilt = (s) => s.leading + s.chunks.map((c) => c.text + c.separator).join("");
const doc = "  First paragraph.\nSecond line.\n\nSecond paragraph.\n\n\nThird.\n";
check("one chunk", split(doc, 1000), {
  leading: "  ",
  chunks: [{ text: "First paragraph.\nSecond line.\n\nSecond paragraph.\n\n\nThird.", separator: "\n" }],
});
check(
  "paragraphs packed while they fit",
  split(doc, 8).chunks.map((c) => [c.text, c.separator]),
  [["First paragraph.\nSecond line.", "\n\n"], ["Second paragraph.\n\n\nThird.", "\n"]],
);
check("lossless", [rebuilt(split(doc, 1000)), rebuilt(split(doc, 8)), rebuilt(split(doc, 3))], [doc, doc, doc]);
const long = "これは文です。".repeat(40) + "\n\nShort.";
check("a long paragraph is lossless", rebuilt(split(long, 50)), long);
check("its pieces fit", split(long, 50).chunks.every((c) => estimateTokens(c.text) <= 50), true);
const noBoundary = "あ".repeat(130);
check("no boundary", [split(noBoundary, 50).chunks.map((c) => c.text.length), rebuilt(split(noBoundary, 50))], [[50, 50, 30], noBoundary]);
const english = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
check("sentences are lossless", rebuilt(split(english, 40)), english);
const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
check("words are not cut", split(words, 50).chunks.every((c) => /^word\d+( word\d+)*$/.test(c.text)), true);
check("words are lossless", rebuilt(split(words, 50)), words);
const quoted = "「始めましょう。」と彼は言った。".repeat(40);
check("closing brackets stay with their sentence", split(quoted, 30).chunks.every((c) => !/^[」』）)]/.test(c.text)), true);
check("sentences fit", split(english, 40).chunks.every((c) => estimateTokens(c.text) <= 40) && split(english, 40).chunks.length > 1, true);

const history = new History(100);
for (let i = 0; i < 10; i++) history.add(`source ${i}${" ".repeat(40)}`, `訳${i}`);
check("history within its budget", history.tokens <= 100, true);
const before = history.pairs.map((p) => p.source);
history.add("next", "次");
check("history appends while it fits", history.pairs.map((p) => p.source).slice(0, before.length), before);
const small = new History(10);
small.add("x".repeat(200), "y");
check("a pair too large clears it", small.pairs.length, 0);

console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
