// Finds the paragraphs of a PDF page from the positions of its text, for the extension's PDF
// viewer (pdf-view.js). Nothing here touches the page or PDF.js, so that it runs in tests
// (tests/extension/pdf-layout.test.mjs).
//
// A piece of text is { str, x, y (its baseline), w, size, top, bottom, font, bold, italic, mono,
// serif, math }, in points from the page's top left. Pieces on one baseline make a line, and
// lines of one size, close together and aligned, make a paragraph. Formulas are told by their
// fonts (TeX's math fonts and the like) and symbols: a line that is mostly formula is left as
// drawn, and a formula inside a paragraph goes into the translation as an image of it.

// Fonts of formulas: TeX's (Computer Modern, AMS, Latin Modern, STIX…), Word's (Cambria Math), Symbol.
const MATH_FONT =
  /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|EUEX|RSFS|STMARY|WASY|ESINT|BBM|DSROM|MTSY|MTMI|MTEX|TXSY|TXMI|TXEX|PXSY|PXMI|PXEX|Math|(^|\+)Symbol/i;
// Symbols of formulas: Greek, primes, arrows, operators, mathematical letters.
const MATH_CHAR = /[Ͱ-Ͽ′-‷⁡-⁤←-⇿∀-⋿⌈-⌋⟀-⟯⦀-⫿\u{1d400}-\u{1d7ff}]/u;
// Names of functions set upright in formulas.
const MATH_WORD = /^(?:log|ln|exp|sin|cos|tan|tanh|max|min|arg|argmax|argmin|lim|sup|inf|det|dim|Pr|softmax|sign|diag|tr|mod)$/;
const LETTER = /\p{L}/u;
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
const BOLD = /Bold|Black|Heavy|Semibold|Demi|CMBX|Medi/i;
const ITALIC = /Italic|Oblique|CMTI|CMSL/i;
// Marks that start a list item or a footnote: a paragraph of its own.
const BULLET = /^[•●▪◦‣∙·*∗†‡§¶]/;
// A numbered heading (`3.1 Results`, `A.2 Proofs`): a paragraph of its own among bold lines.
const HEADING = /^(?:\d+(?:\.\d+)*\.?|[A-Z]\.\d*(?:\.\d+)*)\s+\p{Lu}/u;

// Kinds of fonts, by their names. The fonts' own flags are often wrong in PDFs (a subset of a
// Roman font that says nothing, a CJK font that says monospace), so the names come first.
const MONO_FONT =
  /Mono(?!type)|Courier|Consol|Typewriter|NimbusMon|Menlo|Monaco|Inconsolata|SourceCode|Andale|LucidaConsole|Terminal|OCR[AB]|(?:^|\+)(?:CM|SF|EC|LM)(?:SL|IT|VT)?TT\d/i;
const SANS_FONT =
  /Sans|Gothic|Helvet|Arial|Verdana|Tahoma|Calibri|Segoe|Roboto|Meiryo|CMSS|Univers|Futura|Frutiger|Myriad|Avenir|Lato|Hiragino ?Kaku|HiraKaku|YuGo|Osaka|ゴシック|メイリオ|黑体|Hei(?:ti)?(?:$|[^a-z])/i;
const SERIF_FONT =
  /Times|Roman|NimbusRom|Serif|Mincho|Ming|Song|SimSun|Garamond|Georgia|Palatino|Bookman|Century|Schoolbook|Minion|Charter|Utopia|Cambria|Caslon|Bodoni|Didot|Libertine|STIX|Baskerville|Antiqua|Ryumin|明朝|宋体|(?:^|\+)(?:CM(?:R|BX|TI|SL|CSC|U|DUNH|B)|SF(?:RM|BX|TI|SL)|EC(?:RM|BX|TI|SL))\d/i;

/**
 * What a font is, from its name: { mono, serif, bold, italic }. `flags` are what the PDF says
 * ({ mono, serif, bold, italic }, each possibly undefined), which count where the name tells
 * nothing.
 */
export function fontKind(name, flags = {}) {
  const sans = SANS_FONT.test(name);
  const roman = SERIF_FONT.test(name);
  const mono = MONO_FONT.test(name) || (!!flags.mono && !sans && !roman);
  const serif = !mono && !sans && (roman || !!flags.serif);
  return { mono, serif, bold: !!flags.bold || BOLD.test(name), italic: !!flags.italic || ITALIC.test(name) };
}

/**
 * Text as the model should read it. PDFs made from CJK fonts often give radicals (⽣, U+2F00…)
 * for the characters that look the same (生), and ligatures (ﬁ) for their letters.
 */
export function normalize(str) {
  return str.replace(/[⺀-⻳⼀-⿕ﬀ-ﬆ]/g, (ch) => ch.normalize("NFKC"));
}

/** Whether a piece is formula, by its font's name or its symbols. */
export function isMath(name, str) {
  return MATH_FONT.test(name) || mathSymbols(str);
}

function mathSymbols(str) {
  const s = str.trim();
  return s.length > 0 && s.length <= 4 && MATH_CHAR.test(s) && ![...s].some((ch) => LETTER.test(ch) && !MATH_CHAR.test(ch));
}

/**
 * Pieces on one baseline, next to each other, make a line; a wide gap (between columns) ends it.
 * Formula pieces only need to overlap the line: radicals, fractions, and large operators sit
 * above and below it, and the parts of a fraction stand over one another.
 */
export function linesOf(items) {
  const lines = [];
  let line = null;
  for (const it of items) {
    const size = line ? Math.max(line.size, it.size) : it.size;
    const onBaseline = line && Math.abs(it.y - line.y) < 0.6 * size;
    const overlaps = line && it.math && it.top < line.bottom && it.bottom > line.top;
    const after = line && it.x > line.right - (it.math ? 3 : 0.6) * size && it.x - line.right < 1.2 * size;
    const same = line && (onBaseline || overlaps) && after;
    if (same) {
      line.items.push(it);
      line.right = Math.max(line.right, it.x + it.w);
      line.top = Math.min(line.top, it.top);
      line.bottom = Math.max(line.bottom, it.bottom);
      // The baseline is that of the main text, not of an index or exponent.
      if (it.size > line.size * 1.05) {
        line.size = it.size;
        line.y = it.y;
      }
    } else {
      line = { items: [it], left: it.x, right: it.x + it.w, y: it.y, size: it.size, top: it.top, bottom: it.bottom };
      lines.push(line);
    }
  }
  for (const ln of lines) describe(ln);
  return lines;
}

/** Marks the formula pieces of a line, and what the line mostly is. */
function describe(line) {
  const { items } = line;
  // Digits, signs, and function names beside a formula piece belong to the formula, as do the
  // small pieces next to it (indices, exponents).
  for (let pass = 0; pass < 2; pass++) {
    items.forEach((it, i) => {
      if (it.math) return;
      const s = it.str.trim();
      if (!s) return;
      const prev = items[i - 1];
      const next = items[i + 1];
      const close = 0.6 * line.size;
      const beside = (prev?.math && it.x - (prev.x + prev.w) < close) || (next?.math && next.x - (it.x + it.w) < close);
      if (!beside) return;
      const symbolic = !LETTER.test(s) || MATH_WORD.test(s);
      const small = it.size < 0.8 * line.size;
      if (symbolic || small) it.math = true;
    });
  }
  let chars = 0;
  let math = 0;
  let words = 0;
  const weight = new Map();
  for (const it of items) {
    const n = it.str.replace(/\s/g, "").length;
    chars += n;
    if (it.math) {
      math += n;
    } else {
      words += (it.str.match(/\p{L}{3,}/gu) || []).length;
      const k = `${it.font}|${it.size.toFixed(1)}`;
      weight.set(k, (weight.get(k) ?? 0) + n);
    }
  }
  line.chars = chars;
  // Mostly formula, or a formula with a word or two (`Attention(Q, K, V) = …`).
  line.math = chars > 0 && (math / chars > 0.5 || (words === 0 && math > 0) || (words <= 2 && math >= 3 && math >= 0.3 * chars));
  // The line's main font: that of most of its text.
  const main = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const it = items.find((i) => !i.math && `${i.font}|${i.size.toFixed(1)}` === main) ?? items[0];
  line.size = it.size;
  line.bold = it.bold;
  line.italic = it.italic;
  line.serif = it.serif;
  line.mono = it.mono;
}

/**
 * Lines of one size and weight, close below one another and aligned, make a paragraph.
 * `pageWidth` is the page's, in points.
 */
export function blocksOf(lines, pageWidth) {
  const blocks = [];
  let block = null;
  for (const ln of lines) {
    // Formulas on lines of their own stay as drawn, and end the paragraph.
    if (ln.math || !ln.chars) {
      block = null;
      continue;
    }
    if (block && continues(block, ln, pageWidth)) {
      const last = block.lines.at(-1);
      block.gaps.push(ln.y - last.y);
      block.lines.push(ln);
      block.left = Math.min(block.left, ln.left);
      block.right = Math.max(block.right, ln.right);
      block.top = Math.min(block.top, ln.top);
      block.bottom = Math.max(block.bottom, ln.bottom);
    } else {
      block = { lines: [ln], gaps: [], left: ln.left, right: ln.right, top: ln.top, bottom: ln.bottom, size: ln.size };
      blocks.push(block);
    }
  }
  return blocks;
}

function continues(block, ln, pageWidth) {
  const last = block.lines.at(-1);
  const { size } = block;
  const first = block.lines[0];
  if (Math.abs(ln.size - size) > 0.15 * size || ln.bold !== first.bold || ln.mono !== first.mono) return false;
  const gap = ln.y - last.y;
  if (gap < 0.5 * size || gap > 1.75 * size) return false;
  if (block.gaps.length && gap > 1.3 * median(block.gaps)) return false;
  const text = lineText(ln).trimStart();
  if (BULLET.test(text)) return false;
  // Headings one below the other (`3. Method`, `3.1 Data`) are each their own.
  if (first.bold && HEADING.test(text)) return false;
  // A centered paragraph (a title, a notice): its lines begin anywhere.
  if (centered(block, ln, pageWidth)) return true;
  // Indented: the first line of the next paragraph. Elsewhere: another column or box.
  if (ln.left > block.left + 0.8 * size || ln.left < block.left - 4 * size) return false;
  if (ln.right < block.left || ln.left > block.right) return false;
  // The line before ended short of the others: the paragraph ended there.
  if (block.lines.length >= 2 && last.right < block.right - 3 * size) return false;
  return true;
}

const middle = (box) => (box.left + box.right) / 2;

/**
 * Whether `ln` goes on a centered paragraph: around the same middle as all its lines, and
 * beginning well apart from them (an indent is smaller, and moves the middle). Only wide text:
 * short centered lines below one another are a name, a place, an address, each its own.
 */
function centered(block, ln, pageWidth) {
  const { size } = block;
  if (Math.max(block.right - block.left, ln.right - ln.left) < 0.45 * pageWidth) return false;
  if (Math.abs(ln.left - block.left) <= 2.5 * size) return false;
  const c = middle(ln);
  return block.lines.every((l) => Math.abs(middle(l) - c) <= 0.5 * size);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function lineText(ln) {
  return ln.items.map((it) => it.str).join("");
}

/** The usual distance between a paragraph's baselines, in its font size (1.15 for one line). */
export function lineHeight(block) {
  return block.gaps.length ? median(block.gaps) / block.size : 1.15;
}

/**
 * The paragraph's content: text, and formulas inside it as boxes to show as images. Lines are
 * joined with a space (none between CJK characters), and a word hyphenated at the end of a
 * line is joined again.
 */
export function partsOf(block) {
  const parts = [];
  const text = (s) => {
    const last = parts.at(-1);
    if (last?.text !== undefined) last.text += s;
    else parts.push({ text: s });
  };
  const tail = () => parts.at(-1)?.text ?? "";
  block.lines.forEach((ln, i) => {
    if (i > 0) {
      const first = ln.items.find((it) => it.str.trim());
      const next = first && !first.math ? first.str.trimStart() : "";
      const before = tail().trimEnd();
      if (/\p{L}-$/u.test(before) && /^\p{Ll}/u.test(next)) {
        parts.at(-1).text = before.slice(0, -1);
      } else if (!(CJK.test(before.at(-1) ?? "") && CJK.test(next[0] ?? ""))) {
        text(" ");
      }
    }
    let prev = null;
    for (const it of ln.items) {
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      const spaced = gap > 0.15 * ln.size;
      if (it.math) {
        const last = parts.at(-1);
        if (prev?.math && last?.box) {
          last.box.left = Math.min(last.box.left, it.x);
          last.box.right = Math.max(last.box.right, it.x + it.w);
          last.box.top = Math.min(last.box.top, it.top);
          last.box.bottom = Math.max(last.box.bottom, it.bottom);
        } else {
          if (spaced && !/\s$/.test(tail())) text(" ");
          parts.push({ box: { left: it.x, right: it.x + it.w, top: it.top, bottom: it.bottom }, baseline: ln.y, size: ln.size, line: ln });
        }
      } else {
        if (prev && spaced && !/\s$/.test(tail()) && !/^\s/.test(it.str)) text(" ");
        text(it.str);
      }
      prev = it;
    }
  });
  for (const part of parts) if (part.text !== undefined) part.text = part.text.replace(/\s+/g, " ");
  return parts;
}

/**
 * Whether a paragraph is worth translating: words, not numbers; not a small label in a figure.
 * `bodySize` is the font size of most of the document's text.
 */
export function worthTranslating(parts, block, bodySize) {
  const text = parts.map((p) => p.text ?? "").join("");
  const visible = text.replace(/\s/g, "");
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters < 2 || letters < 0.5 * visible.length) return false;
  const words = (text.match(/\p{L}{2,}/gu) || []).length;
  const cjk = (text.match(new RegExp(CJK.source, "g")) || []).length;
  return words >= 3 || cjk >= 4 || block.size >= 0.9 * bodySize;
}

/** How the paragraph's lines sit: centered (titles), justified, or from the left. */
export function alignment(block, pageWidth) {
  const { lines } = block;
  if (lines.length < 2) {
    return Math.abs(middle(block) - pageWidth / 2) < 0.02 * pageWidth && block.right - block.left < 0.8 * pageWidth ? "center" : "left";
  }
  const lefts = lines.map((l) => l.left);
  const spread = Math.max(...lefts) - Math.min(...lefts);
  const centers = lines.map(middle);
  const centerSpread = Math.max(...centers) - Math.min(...centers);
  if (spread > block.size && centerSpread < 0.5 * block.size) return "center";
  // Justified when the lines but the last fill the width; a short block (a name over an
  // address) would have its few words spread out.
  const full = lines.slice(0, -1).every((l) => block.right - l.right < block.size);
  return lines.length >= 3 && full ? "justify" : "left";
}
