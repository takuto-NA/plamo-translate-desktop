// What the `auto` target means for a text: Japanese ⇄ English, as in the app (`looks_japanese`
// in crates/appdata). Japanese text goes into English, everything else into Japanese.
//
// Text is Japanese when it has kana (kanji alone could be Chinese), and kana and kanji make up a
// tenth of its letters or more: an English text that quotes a few Japanese words is not.
//
// A plain script: the background loads it (importScripts) to settle the target before it looks
// a translation up or asks an engine for it, the in-browser engine's page (engine.html) for
// requests that still say `auto`, and the tests (tests/extension/auto-target.test.mjs).

var resolveTarget = (() => {
  const KANA = /[぀-ヿㇰ-ㇿ]/g;
  const KANJI = /[㐀-䶿一-鿿]/g;
  const LETTER = /\p{Alphabetic}/gu;
  const count = (text, pattern) => (text.match(pattern) || []).length;

  /** `target`, or for `auto` (or none) the language `text` goes into: `en` or `ja`. */
  return (target, text) => {
    if (target && target !== "auto") return target;
    const kana = count(text, KANA);
    const japanese = kana + count(text, KANJI);
    const other = count(text.replace(KANA, "").replace(KANJI, ""), LETTER);
    return kana > 0 && japanese * 9 >= other ? "en" : "ja";
  };
})();

if (typeof module === "object") module.exports = resolveTarget;
