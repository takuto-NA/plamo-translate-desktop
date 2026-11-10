// The extension's PDF viewer (pdf.html). The browser's own viewer is closed to extensions, so a
// PDF to translate is shown here instead: each page is drawn by PDF.js, as in the browser, and
// each paragraph's text is put in a box of its own over the paragraph as drawn. page.js then
// translates those boxes like the paragraphs of any page, and a translated box covers its
// paragraph, while figures, formulas, tables, and everything else stay as drawn.
//
// Paragraphs are found from the positions of the text: pieces on one baseline make a line, and
// lines of one size, close together and aligned, make a paragraph. Formulas are told by their
// fonts (TeX's math fonts and the like) and symbols: a line that is mostly formula is left as
// drawn, and a formula inside a paragraph goes into the translation as an image of it.
//
// The file comes from the tab the PDF was open in (background.js reads it there, as the page
// would, and hands it over by `key`), or else from its address (`src`).

import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const source = params.get("src") ?? "";
const key = params.get("key");

/** The widest page is shown at most this wide (CSS pixels), and otherwise as wide as the window. */
const MAX_WIDTH = 1000;
/** A transparent pixel, for formula images not drawn yet (an image without a source has no size). */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Fonts of formulas: TeX's (Computer Modern, AMS, Latin Modern, STIX…), Word's (Cambria Math), Symbol.
const MATH_FONT =
  /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|EUEX|RSFS|STMARY|WASY|ESINT|BBM|DSROM|MTSY|MTMI|MTEX|TXSY|TXMI|TXEX|PXSY|PXMI|PXEX|Math|(^|\+)Symbol/i;
// Symbols of formulas: Greek, primes, arrows, operators, mathematical letters.
const MATH_CHAR = /[Ͱ-Ͽ′-‷⁡-⁤←-⇿∀-⋿⌈-⌋⟀-⟯⦀-⫿\u{1d400}-\u{1d7ff}]/u;
// Names of functions set upright in formulas.
const MATH_WORD = /^(?:log|ln|exp|sin|cos|tan|tanh|max|min|arg|argmax|argmin|lim|sup|inf|det|dim|Pr|softmax|sign|diag|tr|mod)$/;
const LETTER = /\p{L}/u;
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
const BOLD = /Bold|Black|Heavy|Semibold|Demi|CMBX|Medi/i;
const ITALIC = /Italic|Oblique|CMTI|CMSL/i;
// Marks that start a list item or a footnote: a paragraph of its own.
const BULLET = /^[•●▪◦‣∙·*∗†‡§¶]/;

/**
 * The pages, in order: { number, page (PDF.js), viewport (scale 1), section, canvas, drawn (the
 * scale drawn at), drawing, blocks: [{ el, box }], maths: [{ id, box }], analyzed, colored }.
 */
const pages = [];
/** CSS pixels per PDF point. */
let scale = 1.333;
let nextMath = 1;
/** The font size of most text, in points: smaller pieces are labels (in figures, say). */
let bodySize = 0;
const sizes = new Map();

// ---- Loading ----

async function loadData() {
  if (key) {
    const response = await chrome.runtime.sendMessage({ type: "pdf_data", key }).catch(() => null);
    if (response?.data) return new Uint8Array(await (await fetch(response.data)).arrayBuffer());
  }
  // Read here: possible with the extension's access to the site (or, for a file, to file URLs).
  const response = await fetch(source);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function fileName() {
  try {
    const url = new URL(source);
    return decodeURIComponent(url.pathname.split("/").pop() || url.hostname);
  } catch {
    return source;
  }
}

function showMessage(text) {
  $("message").textContent = text;
  $("message").hidden = false;
}

async function main() {
  await loadUiLanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  document.documentElement.lang = uiLocale();
  $("name").textContent = fileName();
  $("name").title = source;
  document.title = `${fileName()} — PLaMo Translate`;
  $("openSource").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: source });
  });
  $("original").addEventListener("change", () => document.body.classList.toggle("original", $("original").checked));
  showMessage(t("pdfLoading"));

  let doc;
  try {
    const data = await loadData();
    doc = await pdfjs.getDocument({
      data,
      cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("vendor/pdfjs/wasm/"),
      iccUrl: chrome.runtime.getURL("vendor/pdfjs/iccs/"),
      // The fonts' names, which tell formulas.
      fontExtraProperties: true,
    }).promise;
  } catch (e) {
    const message = String(e?.message ?? e);
    showMessage(source.startsWith("file:") ? `${t("pdfLoadFailed", message)} ${t("pdfFileAccess")}` : t("pdfLoadFailed", message));
    return;
  }
  $("message").hidden = true;
  const title = (await doc.getMetadata().catch(() => null))?.info?.Title;
  if (title?.trim()) document.title = `${title.trim()} — PLaMo Translate`;
  $("info").textContent = t("pdfPages", String(doc.numPages));

  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const section = document.createElement("section");
    section.className = "page";
    section.style.setProperty("--w", viewport.width);
    section.style.setProperty("--h", viewport.height);
    $("pages").append(section);
    pages.push({ number, page, viewport, section, canvas: null, drawn: 0, drawing: false, blocks: [], maths: [] });
  }
  fitScale();
  for (const entry of pages) visibility.observe(entry.section);

  // Page by page, in order: page.js takes each page's paragraphs as they are added. It starts
  // with the first pages, so that the translation does not wait for a long PDF.
  for (const entry of pages) {
    try {
      await analyze(entry);
    } catch (e) {
      console.warn(`page ${entry.number}:`, e);
    }
    if (entry.number === Math.min(2, pages.length)) startTranslation();
  }
}

// ---- Drawing ----

function fitScale() {
  const widest = Math.max(...pages.map((p) => p.viewport.width));
  const room = Math.min(MAX_WIDTH, document.documentElement.clientWidth - 32);
  scale = Math.max(0.5, room / widest);
  document.documentElement.style.setProperty("--s", scale);
}

/** Pages are drawn when they come near the view, and let go far from it. */
const visibility = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      const entry = pages.find((p) => p.section === target);
      if (!entry) continue;
      if (isIntersecting) {
        draw(entry);
      } else if (entry.canvas) {
        entry.canvas.remove();
        entry.canvas = null;
        entry.drawn = 0;
      }
    }
  },
  { rootMargin: "150% 0px" },
);

async function draw(entry) {
  const want = scale * devicePixelRatio;
  if (entry.drawing || entry.drawn === want) return;
  entry.drawing = true;
  try {
    const viewport = entry.page.getViewport({ scale: want });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    // Text antialiased in gray: an opaque canvas (PDF.js's own) gets the colored fringes of
    // subpixel rendering, which formula images would keep, and translations would take as the
    // text's color.
    const canvasContext = canvas.getContext("2d", { alpha: true });
    await entry.page.render({ canvas: null, canvasContext, viewport }).promise;
    entry.canvas?.remove();
    entry.section.prepend(canvas);
    entry.canvas = canvas;
    entry.drawn = want;
    paint(entry);
  } catch (e) {
    console.warn(`page ${entry.number}: cannot draw`, e);
  } finally {
    entry.drawing = false;
  }
  // The scale may have changed meanwhile.
  if (entry.canvas && entry.drawn !== scale * devicePixelRatio) draw(entry);
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fitScale();
    for (const entry of pages) if (entry.canvas) draw(entry);
    for (const entry of pages) for (const { el } of entry.blocks) fit(el);
  }, 300);
});

/**
 * Once the page is drawn: the images of its formulas, and each paragraph's colors (the page's
 * color under it and the text's), which its translation then takes.
 */
function paint(entry) {
  if (!entry.analyzed || entry.colored || !entry.canvas) return;
  entry.colored = true;
  const { canvas } = entry;
  const k = canvas.width / entry.viewport.width;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  for (const { id, box } of entry.maths) {
    const [x, y, w, h] = pixels(box, k, canvas);
    if (w < 1 || h < 1) continue;
    const piece = document.createElement("canvas");
    piece.width = w;
    piece.height = h;
    piece.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
    piece.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      // Also in the copies page.js put into translations.
      for (const img of document.querySelectorAll(`img[data-math="${id}"]`)) img.src = url;
    });
  }
  for (const { el, box } of entry.blocks) {
    const [x, y, w, h] = pixels(box, k, canvas);
    if (w < 1 || h < 1) continue;
    const { paper, ink } = colorsOf(ctx.getImageData(x, y, w, h).data);
    el.style.setProperty("--paper", paper);
    el.style.setProperty("--ink", ink);
  }
}

function pixels(box, k, canvas) {
  const x = Math.max(0, Math.floor(box.left * k));
  const y = Math.max(0, Math.floor(box.top * k));
  const w = Math.min(canvas.width - x, Math.ceil((box.right - box.left) * k));
  const h = Math.min(canvas.height - y, Math.ceil((box.bottom - box.top) * k));
  return [x, y, w, h];
}

/**
 * The page's color under the text (the most common one) and the text's: the mean of the pixels
 * well unlike the page. A mean, since antialiasing spreads small text over many shades.
 */
function colorsOf(data) {
  const counts = new Map();
  const step = Math.max(1, Math.floor(data.length / 4 / 4000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    const bin = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const c = counts.get(bin) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += data[i];
    c.g += data[i + 1];
    c.b += data[i + 2];
    counts.set(bin, c);
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const paper = top ? [top.r / top.n, top.g / top.n, top.b / top.n] : [255, 255, 255];
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const base = luma(...paper);
  // The cores of the glyphs, or for thin text all that stands out.
  const mean = (threshold) => {
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < data.length; i += step) {
      if (Math.abs(luma(data[i], data[i + 1], data[i + 2]) - base) <= threshold) continue;
      sum[0] += data[i];
      sum[1] += data[i + 1];
      sum[2] += data[i + 2];
      n++;
    }
    return n >= 20 ? sum.map((v) => v / n) : null;
  };
  const ink = mean(160) ?? mean(96) ?? (base > 128 ? [0, 0, 0] : [255, 255, 255]);
  const css = (c) => `rgb(${c.map(Math.round).join(" ")})`;
  return { paper: css(paper), ink: css(ink) };
}

// ---- Finding the paragraphs ----

/** The page's pieces of text, in points from its top left, with their fonts. */
async function pieces(entry) {
  const { page, viewport } = entry;
  // Loads the fonts, whose names tell formulas. Drawing the page uses the same list later.
  await page.getOperatorList();
  const content = await page.getTextContent();
  const out = [];
  for (const item of content.items) {
    if (!item.str) continue;
    const [a, b, c, d, e, f] = pdfjs.Util.transform(viewport.transform, item.transform);
    // Rotated or vertical text stays as drawn.
    if (a <= 0 || Math.abs(b) > 0.05 * a) continue;
    const size = Math.hypot(c, d);
    if (size < 2) continue;
    const style = content.styles[item.fontName] ?? {};
    if (style.vertical) continue;
    const font = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null;
    const name = font?.name ?? "";
    const ascent = Math.min(1.1, Math.max(0.6, style.ascent || 0.8));
    const descent = Math.min(0.4, Math.max(0.1, -(style.descent || -0.2)));
    out.push({
      str: item.str,
      x: e,
      y: f,
      w: item.width * viewport.scale,
      size,
      top: f - ascent * size,
      bottom: f + descent * size,
      font: item.fontName,
      bold: !!font?.bold || BOLD.test(name),
      italic: !!font?.italic || ITALIC.test(name),
      mono: !!font?.isMonospace || style.fontFamily === "monospace",
      serif: font?.isSerifFont ?? style.fontFamily === "serif",
      math: MATH_FONT.test(name) || mathSymbols(item.str),
    });
  }
  return out;
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
function linesOf(items) {
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

/** Lines of one size and weight, close below one another and aligned, make a paragraph. */
function blocksOf(lines) {
  const blocks = [];
  let block = null;
  for (const ln of lines) {
    // Formulas on lines of their own stay as drawn, and end the paragraph.
    if (ln.math || !ln.chars) {
      block = null;
      continue;
    }
    if (block && continues(block, ln)) {
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

function continues(block, ln) {
  const last = block.lines.at(-1);
  const { size } = block;
  const first = block.lines[0];
  if (Math.abs(ln.size - size) > 0.15 * size || ln.bold !== first.bold || ln.mono !== first.mono) return false;
  const gap = ln.y - last.y;
  if (gap < 0.5 * size || gap > 1.75 * size) return false;
  if (block.gaps.length && gap > 1.3 * median(block.gaps)) return false;
  // Indented: the first line of the next paragraph. Elsewhere: another column or box.
  if (ln.left > block.left + 0.8 * size || ln.left < block.left - 4 * size) return false;
  if (ln.right < block.left || ln.left > block.right) return false;
  // The line before ended short of the others: the paragraph ended there.
  if (block.lines.length >= 2 && last.right < block.right - 3 * size) return false;
  if (BULLET.test(lineText(ln).trimStart())) return false;
  return true;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function lineText(ln) {
  return ln.items.map((it) => it.str).join("");
}

/**
 * The paragraph's content: text, and formulas inside it as boxes to show as images. Lines are
 * joined with a space (none between CJK characters), and a word hyphenated at the end of a
 * line is joined again.
 */
function partsOf(block) {
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

/** Whether a paragraph is worth translating: words, not numbers; not a small label in a figure. */
function worthTranslating(parts, block) {
  const text = parts.map((p) => p.text ?? "").join("");
  const visible = text.replace(/\s/g, "");
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters < 2 || letters < 0.5 * visible.length) return false;
  const words = (text.match(/\p{L}{2,}/gu) || []).length;
  const cjk = (text.match(new RegExp(CJK.source, "g")) || []).length;
  return words >= 3 || cjk >= 4 || block.size >= 0.9 * bodySize;
}

/** How the paragraph's lines sit: centered (titles), justified, or from the left. */
function alignment(block) {
  const { lines } = block;
  if (lines.length < 2) {
    const center = (block.left + block.right) / 2;
    return Math.abs(center - pageCenter) < 0.02 * pageWidth && block.right - block.left < 0.8 * pageWidth ? "center" : "left";
  }
  const lefts = lines.map((l) => l.left);
  const spread = Math.max(...lefts) - Math.min(...lefts);
  const centers = lines.map((l) => (l.left + l.right) / 2);
  const centerSpread = Math.max(...centers) - Math.min(...centers);
  if (spread > block.size && centerSpread < 0.5 * block.size) return "center";
  // Justified when the lines but the last fill the width; a short block (a name over an
  // address) would have its few words spread out.
  const full = lines.slice(0, -1).every((l) => block.right - l.right < block.size);
  return lines.length >= 3 && full ? "justify" : "left";
}
let pageCenter = 0;
let pageWidth = 0;

async function analyze(entry) {
  const items = await pieces(entry);
  const lines = linesOf(items);
  // The size of most text so far, which tells labels and notes apart.
  for (const ln of lines) if (!ln.math) sizes.set(ln.size.toFixed(1), (sizes.get(ln.size.toFixed(1)) ?? 0) + ln.chars);
  bodySize = Number([...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10);
  const { width, height } = entry.viewport;
  pageCenter = width / 2;
  pageWidth = width;
  const fragment = document.createDocumentFragment();
  for (const block of blocksOf(lines)) {
    const parts = partsOf(block);
    if (!worthTranslating(parts, block)) continue;
    const el = document.createElement("p");
    el.className = `block ${block.lines[0].mono ? "mono" : block.lines[0].serif ? "serif" : "sans"}`;
    if (block.lines[0].bold) el.classList.add("bold");
    if (block.lines[0].italic) el.classList.add("italic");
    el.dataset.align = alignment(block);
    // A line (a title, a heading, a name) stays one line: it gets smaller rather than wrap.
    if (block.lines.length === 1) el.classList.add("one-line");
    const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;
    Object.assign(el.style, {
      left: pct(block.left, width),
      top: pct(block.top, height),
      width: pct(block.right - block.left, width),
      height: pct(block.bottom - block.top, height),
    });
    el.style.setProperty("--fs", block.size.toFixed(2));
    el.style.setProperty("--lh", block.gaps.length ? (median(block.gaps) / block.size).toFixed(3) : "1.15");
    for (const part of parts) {
      if (part.text !== undefined) {
        el.append(part.text);
        continue;
      }
      const id = `m${nextMath++}`;
      // A little room for strokes past the glyphs' boxes; little to the sides, where the next
      // letters begin.
      const pad = 0.08 * part.size;
      const side = 0.02 * part.size;
      const box = { left: part.box.left - side, right: part.box.right + side, top: part.box.top - pad, bottom: part.box.bottom + pad };
      // Not into the lines above and below (their descenders and capitals): radicals and large
      // operators are given more height than they take.
      const index = block.lines.indexOf(part.line);
      const above = block.lines[index - 1];
      const below = block.lines[index + 1];
      if (above) box.top = Math.max(box.top, above.y + 0.25 * above.size);
      if (below) box.bottom = Math.min(box.bottom, below.y - 0.75 * below.size);
      entry.maths.push({ id, box });
      const img = document.createElement("img");
      img.className = "math";
      img.alt = "";
      img.src = BLANK;
      img.dataset.math = id;
      const em = (v) => `${(v / block.size).toFixed(3)}em`;
      Object.assign(img.style, {
        width: em(box.right - box.left),
        height: em(box.bottom - box.top),
        verticalAlign: em(part.baseline - box.bottom),
      });
      el.append(img);
    }
    entry.blocks.push({ el, box: block });
    originals.set(el, el.textContent.trim());
    fragment.append(el);
  }
  entry.section.append(fragment);
  entry.analyzed = true;
  paint(entry);
}

// ---- Translations in their boxes ----

/**
 * A translation is set in its paragraph's size, and made smaller until it fits the paragraph's
 * box (down to 60%); past that it overflows below.
 */
function fit(el) {
  if (!el.querySelector("[data-plamo-done]")) return;
  el.classList.remove("wrapped");
  el.style.setProperty("--fit", "1");
  const fits = () => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
  if (fits()) return;
  // A line shrinks further (to half), and wraps only if it still does not fit.
  const oneLine = el.classList.contains("one-line");
  if (oneLine && !shrink(el, 0.5, fits)) {
    el.classList.add("wrapped");
    shrink(el, 0.5, fits);
  } else if (!oneLine) {
    shrink(el, 0.6, fits);
  }
}

/** The largest size down to `min` at which the box's text fits; whether one did. */
function shrink(el, min, fits) {
  el.style.setProperty("--fit", String(min));
  if (!fits()) return false;
  let low = min;
  let high = 1;
  for (let i = 0; i < 7; i++) {
    const mid = (low + high) / 2;
    el.style.setProperty("--fit", String(mid));
    if (fits()) low = mid;
    else high = mid;
  }
  el.style.setProperty("--fit", String(low));
  return true;
}

// The original text of a translated paragraph shows as its tooltip.
const originals = new WeakMap();
new MutationObserver((mutations) => {
  const touched = new Set();
  for (const m of mutations) {
    const el = m.target.closest?.(".block") ?? m.target.parentElement?.closest(".block");
    if (el) touched.add(el);
  }
  for (const el of touched) {
    if (!originals.has(el)) continue;
    el.title = el.querySelector("[data-plamo-done]") ? originals.get(el) : "";
    fit(el);
  }
}).observe($("pages"), { childList: true, subtree: true });

// ---- Translating ----

let pageScript = null;

/** Starts page.js on this page, as background.js does on others (and again when asked). */
function startTranslation() {
  if (window.__plamoPage) {
    window.__plamoPage.start();
    return;
  }
  if (pageScript) return;
  pageScript = document.createElement("script");
  pageScript.src = "page.js";
  document.head.append(pageScript);
}

// The panel's "Translate this page" (and the right-click menu) on this tab.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "pdf_translate") return;
  chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id === message.tabId) startTranslation();
  });
});

main();
