// Prompts and long texts for the in-browser engine (engine.js). A port of the essentials of the
// app's prompt format (crates/pfml) and of its translation of long texts in chunks with the
// earlier pairs as history (crates/engine/src/document.rs), without the app's exact token
// counts and its retries of output that runs away.

const TAG = "<|plamo:tag|>";
const MSG = "<|plamo:msg|>";
const KEY = "<|plamo:key|>";
const VAL = "<|plamo:val|>";

/** The token that starts the next element: generation stops there. */
export const STOP = TAG;

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/g;
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const LETTER = /\p{Alphabetic}/gu;

/**
 * Text as the model reads it. wllama tokenizes the prompt as one string, special tokens included,
 * so text that looks like one gets a zero-width space after `<` (the app tokenizes special
 * tokens apart from the text instead).
 */
export function escape(text) {
  return text.replaceAll("<|", "<​|");
}

/**
 * `auto` is Japanese ⇄ English, as in the app (`looks_japanese` in crates/appdata): Japanese text
 * into English, the rest into Japanese. Text is Japanese when it has kana, and kana and kanji
 * make up a tenth of its letters or more: an English text that quotes a few Japanese words is not.
 */
export function resolveTarget(target, text) {
  if (target && target !== "auto") return target;
  const count = (text, pattern) => (text.match(pattern) || []).length;
  const kana = count(text, KANA);
  const japanese = kana + count(text, KANJI);
  const other = count(text.replace(KANA, "").replace(KANJI, ""), LETTER);
  return kana > 0 && japanese * 9 >= other ? "en" : "ja";
}

/**
 * The prompt for translating `text` into `target`, after the `history` pairs ({ source,
 * translation }). `style` (`polite` or `plain`) applies to Japanese only. wllama adds the BOS
 * token itself.
 */
export function prompt({ text, target, source, style, history = [] }) {
  const input = (t) => TAG + "input" + (source ? KEY + "lang" + VAL + source : "") + MSG + escape(t);
  const output = TAG + "output" + KEY + "lang" + VAL + target;
  let out = TAG + "dataset" + MSG + "translation";
  for (const pair of history) out += input(pair.source) + output + MSG + escape(pair.translation);
  out += input(text) + output;
  if (style && target === "ja") out += KEY + "form" + VAL + style;
  return out + MSG;
}

/**
 * Rough token count for budgets: PLaMo's tokenizer takes about one token per CJK character and
 * about four Latin characters per token.
 */
export function estimateTokens(text) {
  let narrow = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x2e80) narrow++;
    else wide++;
  }
  return Math.ceil(narrow / 4 + wide);
}

/**
 * Splits `text` into chunks of at most `maxTokens` (estimated): paragraphs, packed together while
 * they fit; a paragraph too large is split at line breaks, then after sentences, then between
 * words, then anywhere.
 * Returns { leading, chunks: [{ text, separator }] }: the translation is `leading`, then each
 * chunk's translation followed by its separator.
 */
export function split(text, maxTokens) {
  const body = text.trimStart();
  const leading = text.slice(0, text.length - body.length);
  // Paragraphs and the blank lines after them.
  const pieces = [];
  const re = /\n[ \t]*\n\s*/g;
  let start = 0;
  for (const m of body.matchAll(re)) {
    refine(body.slice(start, m.index), m[0], maxTokens, pieces);
    start = m.index + m[0].length;
  }
  const rest = body.slice(start);
  const trailing = rest.slice(rest.trimEnd().length);
  if (rest.trimEnd()) refine(rest.trimEnd(), trailing, maxTokens, pieces);

  const chunks = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last && estimateTokens(last.text + last.separator + piece.text) <= maxTokens) {
      last.text += last.separator + piece.text;
      last.separator = piece.separator;
    } else {
      chunks.push({ ...piece });
    }
  }
  return { leading, chunks };
}

/** Adds `text` (followed by `separator`) to `out`, split until each piece fits `maxTokens`. */
function refine(text, separator, maxTokens, out) {
  if (estimateTokens(text) <= maxTokens) {
    out.push({ text, separator });
    return;
  }
  // Line breaks, then the space after a sentence, then the end of a CJK sentence (with the
  // closing brackets after it), then any space.
  for (const boundary of [/\n\s*/g, /(?<=[.!?])\s+/g, /(?<=[。！？][」』）)]*)(?![」』）)])/g, /\s+/g]) {
    const parts = [];
    let start = 0;
    for (const m of text.matchAll(boundary)) {
      if (m.index === 0 || m.index + m[0].length >= text.length) continue;
      parts.push({ text: text.slice(start, m.index), separator: m[0] });
      start = m.index + m[0].length;
    }
    if (parts.length) {
      parts.push({ text: text.slice(start), separator });
      for (const part of parts) refine(part.text, part.separator, maxTokens, out);
      return;
    }
  }
  // No boundary: a fixed number of characters (about maxTokens tokens of CJK text).
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += maxTokens) {
    const end = i + maxTokens >= chars.length;
    out.push({ text: chars.slice(i, i + maxTokens).join(""), separator: end ? separator : "" });
  }
}

/**
 * The earlier pairs sent with each request, within `maxTokens`. Pairs are only added at the end
 * and dropped from the start several at a time, so that consecutive prompts mostly begin the
 * same way and llama.cpp can reuse its work on the common beginning.
 */
export class History {
  constructor(maxTokens) {
    this.maxTokens = maxTokens;
    this.pairs = [];
    this.tokens = 0;
  }

  add(source, translation) {
    const cost = estimateTokens(source) + estimateTokens(translation) + 16;
    if (cost > this.maxTokens) {
      this.pairs = [];
      this.tokens = 0;
      return;
    }
    this.pairs.push({ source, translation, cost });
    this.tokens += cost;
    if (this.tokens > this.maxTokens) {
      // Down to half the budget at once, rather than one pair per request.
      while (this.tokens > this.maxTokens / 2) this.tokens -= this.pairs.shift().cost;
    }
  }
}
