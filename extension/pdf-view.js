// The extension's PDF viewer (pdf.html). The browser's own viewer is closed to extensions, so a
// PDF to translate is shown here instead: each page is drawn by PDF.js, as in the browser, and
// each paragraph's text is put in a box of its own over the paragraph as drawn. page.js then
// translates those boxes like the paragraphs of any page, and a translated box covers its
// paragraph, while figures, formulas, tables, and everything else stay as drawn.
//
// The paragraphs are found from the positions of the text (pdf-layout.js).
//
// The file is kept in the browser under `key` (pdf-store.js): the background puts it there from
// the tab the PDF was open in, or else it is read here from its address (`src`) and kept then.
// The translations are kept with it, so a viewer reloaded shows them again and goes on with
// the rest.
//
// "Save as PDF" prints the pages as shown, each on a page of its own size, for the browser to
// save as a PDF.

import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
import { alignment, blocksOf, fontKind, isMath, lineHeight, linesOf, normalize, partsOf, worthTranslating } from "./pdf-layout.js";

pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const source = params.get("src") ?? "";
const key = params.get("key");

/** The browser's page of extensions, where this one's details are. */
const EXTENSIONS_PAGE = navigator.userAgentData?.brands?.some((b) => b.brand === "Microsoft Edge") ? "edge://extensions/" : "chrome://extensions/";
/** The widest page is shown at most this wide (CSS pixels), and otherwise as wide as the window. */
const MAX_WIDTH = 1000;
/** A transparent pixel, for formula images not drawn yet (an image without a source has no size). */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** CSS pixels per PDF point in print, where a CSS point is a PDF point. */
const PRINT_SCALE = 96 / 72;
/** Pages are drawn for print at this many pixels per point (200 per inch), */
const PRINT_PIXELS = 200 / 72;
/** but with no more pixels than this (large formats). */
const PRINT_MAX_PIXELS = 16e6;

/**
 * The pages, in order: { number, page (PDF.js), viewport (scale 1), section, canvas, drawn (the
 * scale drawn at), drawing, blocks: [{ el, box }], maths: [{ id, box }], mathUrls, analyzed,
 * colored, cut }.
 */
const pages = [];
/** CSS pixels per PDF point. */
let scale = 1.333;
let nextMath = 1;
/** The font size of most text, in points: smaller pieces are labels (in figures, say). */
let bodySize = 0;
const sizes = new Map();
/** Pages are still being read for their paragraphs. */
let analyzing = true;
/** The pages are set up for print (see `savePdf`). */
let printing = false;
/** Translations kept from before, by "page:index" (see pdf-store.js). */
let kept = new Map();
/** The panel's settings the translations are made with. */
let settings = { target: "auto", style: "" };
/** The language the "auto" target means for this PDF, which page.js is told (see `autoTarget`). */
let auto = "ja";
/** Each paragraph's place: { page, index, maths (the ids of its formulas, in order) }. */
const places = new WeakMap();

// ---- Loading ----

async function loadData() {
  if (key) {
    const file = await pdfStore.get(key).catch(() => null);
    if (file) return file.bytes;
  }
  // Read here: possible with the extension's access to the site (or, for a file, to file URLs),
  // and then as the site's own pages would, signed in.
  const response = await fetch(source, /^https?:/.test(source) && (await siteAccess()) ? { credentials: "include" } : {});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Before PDF.js takes the bytes away.
  if (key) await pdfStore.put(key, source, bytes).catch(() => {});
  return bytes;
}

/**
 * The pattern of where the PDF is, for the permission to read it: its site, or the files of
 * this computer (which the extension reads only with that permission and, set in its details,
 * the access to file URLs).
 */
function sitePattern() {
  try {
    const url = new URL(source);
    if (url.protocol === "file:") return "file:///*";
    return /^https?:$/.test(url.protocol) ? `${url.protocol}//${url.hostname}/*` : null;
  } catch {
    return null;
  }
}

/** Whether the extension may read where the PDF is. */
async function siteAccess() {
  const pattern = sitePattern();
  return !!pattern && (await chrome.permissions.contains({ origins: [pattern] }).catch(() => false));
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
  $("save").title = t("pdfSaveHint");
  $("save").addEventListener("click", savePdf);
  $("again").title = t("pdfAgainHint");
  $("again").addEventListener("click", async () => {
    if (key) await pdfStore.clearTranslations(key).catch(() => {});
    location.reload();
  });
  showMessage(t("pdfLoading"));

  settings = await chrome.storage.local.get(settings);
  if (key) kept = await pdfStore.translations(key).catch(() => new Map());
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
    showMessage(t("pdfLoadFailed", message));
    // What was kept is not a PDF that can be shown (a sign-in page in its place, say): the next
    // try reads it again.
    if (key) pdfStore.remove(key).catch(() => {});
    const file = source.startsWith("file:");
    const pattern = sitePattern();
    if (file && !(await chrome.extension.isAllowedFileSchemeAccess().catch(() => false))) {
      // The access to file URLs is set in the extension's details, a page of the browser which
      // only `tabs.create` opens (a page cannot link there).
      showMessage(t("pdfFileAccess"));
      $("allow").textContent = t("pdfOpenDetails");
      $("allow").hidden = false;
      $("allow").addEventListener("click", () => chrome.tabs.create({ url: `${EXTENSIONS_PAGE}?id=${chrome.runtime.id}` }));
    } else if (pattern && !(await siteAccess())) {
      // Without the permission for the PDF's site or for files (the viewer opened from the
      // browser's PDF viewer, which gives none): the user can give it here.
      const host = file ? "" : new URL(source).hostname;
      showMessage(file ? t("pdfNeedsFiles") : t("pdfNeedsAccess", host));
      $("allow").textContent = file ? t("pdfAllowFiles") : t("pdfAllow", host);
      $("allow").hidden = false;
      $("allow").addEventListener("click", async () => {
        if (await chrome.permissions.request({ origins: [pattern] }).catch(() => false)) location.reload();
      });
    }
    return;
  }
  $("message").hidden = true;
  const title = (await doc.getMetadata().catch(() => null))?.info?.Title;
  if (title?.trim()) document.title = `${title.trim()} — PLaMo Translate`;
  $("info").textContent = t("pdfPages", String(doc.numPages));
  $("save").disabled = false;
  $("again").disabled = false;

  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const section = document.createElement("section");
    section.className = "page";
    section.style.setProperty("--w", viewport.width);
    section.style.setProperty("--h", viewport.height);
    $("pages").append(section);
    pages.push({ number, page, viewport, section, canvas: null, drawn: 0, drawing: false, blocks: [], maths: [], mathUrls: [] });
  }
  pageSizes();
  fitScale();
  auto = await autoTarget();
  document.documentElement.dataset.plamoPageAuto = auto;
  for (const entry of pages) visibility.observe(entry.section);

  // Page by page, in order: page.js takes each page's paragraphs as they are added. It starts
  // with the first pages, so that the translation does not wait for a long PDF.
  let texts = 0;
  let started = false;
  for (const entry of pages) {
    try {
      texts += await analyze(entry);
    } catch (e) {
      console.warn(`page ${entry.number}:`, e);
    }
    if (!started && texts && (entry.number >= 2 || entry.number === pages.length)) {
      started = true;
      startTranslation();
    }
  }
  analyzing = false;
  if (!texts) {
    // Pictures of pages (a scan): there is no text to find, and none to translate.
    $("notice").textContent = t("pdfNoText");
    $("notice").hidden = false;
  }
}

/**
 * What the automatic target means here, as page.js decides for a page: a Japanese PDF goes into
 * English, any other into Japanese. From the PDF's text, not the page's, which shows
 * translations kept from before when the viewer is loaded again.
 */
async function autoTarget() {
  let sample = "";
  for (const entry of pages.slice(0, 5)) {
    const content = await entry.page.getTextContent().catch(() => null);
    sample += (content?.items ?? []).map((item) => item.str ?? "").join("");
    if (sample.length >= 20000) break;
  }
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  return kana > sample.length * 0.05 ? "en" : "ja";
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
    if (printing) return;
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
  if (!entry.analyzed || !entry.canvas) return;
  if (!entry.cut) cutMaths(entry, entry.canvas);
  if (!entry.colored) color(entry, entry.canvas);
}

/** Cuts the images of the page's formulas out of `canvas`, the page as drawn. */
function cutMaths(entry, canvas) {
  entry.cut = true;
  const k = canvas.width / entry.viewport.width;
  const old = entry.mathUrls;
  entry.mathUrls = [];
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
      entry.mathUrls.push(url);
      // Also in the copies page.js put into translations.
      for (const img of document.querySelectorAll(`img[data-math="${id}"]`)) img.src = url;
    });
  }
  // Those of an earlier cut, once the images have had time to take the new ones.
  if (old.length) setTimeout(() => old.forEach((url) => URL.revokeObjectURL(url)), 5000);
}

function color(entry, canvas) {
  entry.colored = true;
  const k = canvas.width / entry.viewport.width;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
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

/**
 * The page's pieces of text, in points from its top left, with their fonts. `entry.texts` gets
 * the number of all its pieces, those left out here (rotated, vertical) too.
 */
async function pieces(entry) {
  const { page, viewport } = entry;
  // Loads the fonts, whose names tell formulas. Drawing the page uses the same list later.
  await page.getOperatorList();
  const content = await page.getTextContent();
  const out = [];
  entry.texts = 0;
  for (const item of content.items) {
    if (!item.str) continue;
    if (item.str.trim()) entry.texts++;
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
    const str = normalize(item.str);
    out.push({
      str,
      x: e,
      y: f,
      w: item.width * viewport.scale,
      size,
      top: f - ascent * size,
      bottom: f + descent * size,
      font: item.fontName,
      ...fontKind(name, { mono: font?.isMonospace, serif: font?.isSerifFont ?? style.fontFamily === "serif", bold: font?.bold, italic: font?.italic }),
      math: isMath(name, str),
    });
  }
  return out;
}

/** Finds the page's paragraphs and puts their boxes on it. Returns the number of the page's pieces of text. */
async function analyze(entry) {
  const items = await pieces(entry);
  const lines = linesOf(items);
  // The size of most text so far, which tells labels and notes apart.
  for (const ln of lines) if (!ln.math) sizes.set(ln.size.toFixed(1), (sizes.get(ln.size.toFixed(1)) ?? 0) + ln.chars);
  bodySize = Number([...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10);
  const { width, height } = entry.viewport;
  const fragment = document.createDocumentFragment();
  const restored = [];
  for (const block of blocksOf(lines, width)) {
    const parts = partsOf(block);
    if (!worthTranslating(parts, block, bodySize)) continue;
    const el = document.createElement("p");
    el.className = `block ${block.lines[0].mono ? "mono" : block.lines[0].serif ? "serif" : "sans"}`;
    if (block.lines[0].bold) el.classList.add("bold");
    if (block.lines[0].italic) el.classList.add("italic");
    el.dataset.align = alignment(block, width);
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
    el.style.setProperty("--lh", lineHeight(block).toFixed(3));
    const images = [];
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
      images.push(img);
    }
    const place = { page: entry.number, index: entry.blocks.length, maths: images.map((img) => img.dataset.math) };
    places.set(el, place);
    entry.blocks.push({ el, box: block });
    const original = el.textContent.trim();
    originals.set(el, original);
    if (restore(el, kept.get(`${place.page}:${place.index}`), original, images)) restored.push(el);
    fragment.append(el);
  }
  entry.section.append(fragment);
  entry.analyzed = true;
  for (const el of restored) {
    el.title = originals.get(el);
    fit(el);
  }
  paint(entry);
  return entry.texts;
}

// ---- Translations kept ----

/** Whether a translation kept (`record`) is the one the settings now would give for `original`. */
function usable(record, original) {
  if (record?.source !== original) return false;
  if (record.lang !== (settings.target === "auto" ? auto : settings.target)) return false;
  // The style is for Japanese only.
  return record.lang !== "ja" || (record.style ?? "") === (settings.style ?? "");
}

/**
 * Puts a translation kept from before into its paragraph, as page.js left it (which then takes
 * the paragraph for translated). `images` are the paragraph's formulas, in order. Returns
 * whether the paragraph now shows a translation.
 */
function restore(el, record, original, images) {
  if (!usable(record, original)) return false;
  if (!record.parts) {
    // Left as it was (a name, an address): page.js need not ask again.
    el.setAttribute("translate", "no");
    el.dataset.kept = "";
    return false;
  }
  const holder = document.createElement("span");
  holder.setAttribute("data-plamo-done", "");
  holder.lang = record.lang;
  for (const part of record.parts) {
    if (typeof part === "string") holder.append(part);
    else if (images[part]) holder.append(images[part]);
  }
  el.replaceChildren(holder);
  el.dataset.kept = "";
  return true;
}

/** Keeps the translation page.js put into a paragraph, or forgets the one it took back (Undo). */
function keep(el) {
  const place = places.get(el);
  if (!key || !place) return;
  const holder = el.querySelector(":scope > [data-plamo-done]");
  if (holder && !("kept" in el.dataset)) {
    el.dataset.kept = "";
    const parts = [];
    for (const node of holder.childNodes) {
      const math = node.nodeType === Node.ELEMENT_NODE ? place.maths.indexOf(node.dataset.math) : -1;
      if (math >= 0) parts.push(math);
      else if (typeof parts.at(-1) === "string") parts[parts.length - 1] += node.textContent;
      else parts.push(node.textContent);
    }
    const record = { source: originals.get(el), lang: holder.lang, style: settings.style ?? "", parts };
    pdfStore.putTranslation(key, place.page, place.index, record).catch(() => {});
  } else if (!holder && "kept" in el.dataset) {
    delete el.dataset.kept;
    pdfStore.deleteTranslation(key, place.page, place.index).catch(() => {});
  }
}

// page.js says so when a translation is the paragraph's own text, which it then leaves alone.
$("pages").addEventListener("plamo-same", (event) => {
  const el = event.target.closest?.(".block");
  const place = el && places.get(el);
  if (!key || !place || "kept" in el.dataset) return;
  el.dataset.kept = "";
  const record = { source: originals.get(el), lang: event.detail?.lang, style: settings.style ?? "", parts: null };
  pdfStore.putTranslation(key, place.page, place.index, record).catch(() => {});
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.target) settings.target = changes.target.newValue ?? "auto";
  if (changes.style) settings.style = changes.style.newValue ?? "";
});

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

function fitAll() {
  for (const entry of pages) for (const { el } of entry.blocks) fit(el);
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
    keep(el);
  }
}).observe($("pages"), { childList: true, subtree: true });

// ---- Saving as a PDF ----

// The browser saves what it prints. For print, each page of the PDF is a page of its own size
// (pdf.css hides the rest), drawn as an image sharp enough for paper, with the translations
// over it as on screen: text, which stays text in the saved PDF.

/** A page size for print (`@page`) for each size of the PDF's pages. */
function pageSizes() {
  const names = new Map();
  let css = "";
  for (const entry of pages) {
    const { width, height } = entry.viewport;
    const size = `${width.toFixed(2)}pt ${height.toFixed(2)}pt`;
    if (!names.has(size)) {
      names.set(size, `size${names.size}`);
      css += `@page ${names.get(size)} { size: ${size}; margin: 0; }\n.page.${names.get(size)} { page: ${names.get(size)}; }\n`;
    }
    entry.section.classList.add(names.get(size));
  }
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
}

/** The page as an image for print, in place of its canvas (which shows only near the view). */
async function printImage(entry) {
  const { width, height } = entry.viewport;
  const k = Math.min(PRINT_PIXELS, Math.sqrt(PRINT_MAX_PIXELS / (width * height)));
  const viewport = entry.page.getViewport({ scale: k });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await entry.page.render({ canvas: null, canvasContext: canvas.getContext("2d", { alpha: true }), viewport }).promise;
  if (entry.analyzed) {
    // Formulas as sharp as the page; and the colors of a page never shown.
    cutMaths(entry, canvas);
    if (!entry.colored) color(entry, canvas);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error(`page ${entry.number}: no image`);
  const img = document.createElement("img");
  img.className = "print";
  img.alt = "";
  img.src = URL.createObjectURL(blob);
  await img.decode().catch(() => {});
  entry.section.prepend(img);
}

async function savePdf() {
  if (printing || !pages.length) return;
  const state = window.__plamoPage?.state();
  // Paragraphs not translated are saved as they are in the PDF.
  if ((analyzing || (state && (state.waiting || state.stopped))) && !confirm(t("pdfSaveUnfinished"))) return;
  printing = true;
  $("save").disabled = true;
  const info = $("info").textContent;
  try {
    for (const entry of pages) {
      $("info").textContent = t("pdfPreparing", String(entry.number), String(pages.length));
      await printImage(entry);
    }
    // Laid out as in print, so that each translation is fitted to its box as it will print.
    scale = PRINT_SCALE;
    document.documentElement.style.setProperty("--s", scale);
    fitAll();
    // The formula images just cut are on their way into the page.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Returns when the print dialog is closed, after `afterprint`; were it to return at once,
    // the pages stay set up for a moment longer.
    const printed = new Promise((resolve) => addEventListener("afterprint", resolve, { once: true }));
    window.print();
    await Promise.race([printed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  } catch (e) {
    console.warn("cannot print:", e);
  } finally {
    for (const img of document.querySelectorAll("img.print")) {
      URL.revokeObjectURL(img.src);
      img.remove();
    }
    $("info").textContent = info;
    $("save").disabled = false;
    printing = false;
    fitScale();
    fitAll();
  }
}

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
