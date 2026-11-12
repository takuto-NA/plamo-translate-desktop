// Holds the one connection to a translation engine and shares it between the side panels and
// page translation. The engine is the desktop app's browser host (native messaging), or the
// in-browser engine (engine.js in an offscreen document, with wllama) when the app is not
// connected or the panel's settings ask for it. Both speak the host's protocol, described in
// crates/host/src/protocol.rs.
//
// - Panels connect here (port "panel"). Their translations start at once; a page translation
//   in progress is interrupted and its unfinished paragraphs are sent again afterwards.
// - Page translation runs in page.js (port "page"), which sends paragraphs; they go to the
//   host in small batches while no panel translation runs. The app's host runs one batch at a
//   time; the in-browser engine runs several side by side (its status's `slots`).
// - The connection closes after IDLE_MS without work, which ends the host (or closes the
//   offscreen document) and frees the model's memory. Chrome keeps this service worker alive
//   while the host's connection is open; the in-browser engine sends `keepalive` messages.
// - The context menus and page.js show texts in the display language chosen in the panel.

importScripts("i18n.js", "pdf-store.js");

const HOST = "com.github.tanakh.plamo_translate";
const IDLE_MS = 5 * 60 * 1000;
const BATCH_SEGMENTS = 10;
const BATCH_CHARS = 2000;
const MENU_SELECTION = "translate-selection";
const MENU_PAGE = "translate-page";
const MENUS = [
  { id: MENU_SELECTION, message: "menuTranslate", contexts: ["selection"] },
  // Also in frames inside the page: the whole page is translated from there too.
  { id: MENU_PAGE, message: "menuTranslatePage", contexts: ["page", "frame"] },
];

/**
 * The engine connection: { kind: "app" | "browser", port }. Both are null until the engine is
 * chosen and connected (see `hostReady`).
 */
let host = null;
/** Settles once the new connection's `configure` is sent; messages wait for it. */
let hostReady = Promise.resolve();
/**
 * Whether the app's host answers (a promise), for automatic engine selection. Asked again after
 * a release or after it fails, so that an app connected since is used from the next start.
 */
let appAvailable;
/** Resolves with the in-browser engine's port once its document connects. */
let engineConnected = null;
/** Models the in-browser engine is downloading: the connection is busy meanwhile. */
const downloads = new Set();
let idleTimer = null;
let status = { type: "status", state: "released" };
let options = null;
let nextId = 1;

/** Open panel ports. */
const panels = new Set();

/**
 * Posts to a panel's or a page's port. One closed meanwhile throws, which would cut short the
 * bookkeeping around the post; it is gone, so the message is dropped.
 */
function post(port, message) {
  try {
    port?.postMessage(message);
  } catch {}
}
/**
 * Jobs sent to the host whose `done` (or `error`) has not arrived, by id:
 * { id, kind: "panel", port }, { id, kind: "measure", port } (the in-browser engine measuring
 * its devices), or { id, kind: "page", tabId, items, cancelled, counted }.
 * A job superseded by a newer one stays here until the host reports it stopped.
 */
const jobs = new Map();
/** The jobs the host runs, not superseded: a panel translation or measurement, or page batches. */
const active = new Set();
/**
 * Page translations by tab: { port, target, style, pending: [{ sid, text }], busySince,
 * busyTokens }. The last two count the tokens since its batches started, for its speed.
 */
const pages = new Map();

// ---- Engines ----

/** The panel's engine setting: `auto`, `app`, or `browser`. */
async function engineSetting() {
  const { engine } = await chrome.storage.local.get({ engine: "auto" }).catch(() => ({ engine: "auto" }));
  return engine;
}

/** The engine to use: the panel's choice, or on automatic the app if its host answers. */
async function chooseEngine() {
  const engine = await engineSetting();
  if (engine === "app" || engine === "browser") return engine;
  appAvailable ??= probeApp();
  return (await appAvailable) ? "app" : "browser";
}

/** Tells the panels (or `port`) which engine the automatic setting uses, when it is the setting. */
async function reportEngine(port = null) {
  const setting = await engineSetting();
  const auto = setting === "auto" ? (host?.kind ?? (await chooseEngine())) : null;
  const message = { type: "engine", setting, auto };
  if (port) post(port, message);
  else broadcast(message);
}

/** Whether the app's host starts and answers: it is registered, and the app is where it was. */
function probeApp() {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(HOST);
    port.onMessage.addListener(() => {
      resolve(true);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => resolve(false));
    port.postMessage({ type: "status" });
  });
}

/** Opens the in-browser engine's document and waits for it to connect. */
async function openEngine() {
  // Left over from a service worker that stopped: its model belongs to no connection.
  if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) {
    await chrome.offscreen.closeDocument();
  }
  const connected = new Promise((resolve) => (engineConnected = resolve));
  await chrome.offscreen.createDocument({
    url: "engine.html",
    reasons: ["WORKERS"],
    justification: "Runs the translation model with WebAssembly and WebGPU when the desktop app is not connected.",
  });
  return connected;
}

function connectHost() {
  const connection = { kind: null, port: null };
  host = connection;
  hostReady = (async () => {
    const kind = await chooseEngine();
    const port = kind === "browser" ? await openEngine() : chrome.runtime.connectNative(HOST);
    connection.kind = kind;
    connection.port = port;
    if (host !== connection) {
      closeConnection(connection);
      return;
    }
    reportEngine();
    port.onMessage.addListener((message) => onHostMessage(connection, message));
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message ?? "";
      if (connection.kind === "app") appAvailable = undefined;
      if (host !== connection) return;
      host = null;
      clearTimeout(idleTimer);
      endDownloads(error || "disconnected");
      status = { type: "status", state: "disconnected", engine: kind, message: error };
      broadcast(status);
      failAll({ code: "disconnected", message: error });
    });
    // The engine loads a model only after this, so the default one is not loaded in vain. Each
    // engine has its own choices: their models and devices differ.
    const key = kind === "browser" ? "browserChoices" : "choices";
    const { [key]: choices } = await chrome.storage.local.get({ [key]: {} }).catch(() => ({ [key]: {} }));
    if (host === connection) {
      port.postMessage({
        type: "configure",
        model: choices.model || undefined,
        device: choices.device || undefined,
        threads: choices.threads || undefined,
      });
    }
  })().catch((e) => {
    if (host !== connection) return;
    host = null;
    status = { type: "status", state: "disconnected", engine: connection.kind, message: String(e?.message ?? e) };
    broadcast(status);
    failAll({ code: "disconnected", message: status.message });
  });
}

/** Ends a connection from this side, which fires no onDisconnect. */
function closeConnection(connection) {
  connection.port?.disconnect();
  if (connection.kind === "browser") chrome.offscreen.closeDocument().catch(() => {});
}

/** Sends `message` after `configure`, connecting first if needed; messages keep their order. */
async function sendHost(message) {
  if (!host) connectHost();
  const connection = host;
  await hostReady;
  // Dropped if the connection ended meanwhile.
  if (host !== connection || !connection.port) return;
  connection.port.postMessage(message);
  touch();
}

function touch() {
  clearTimeout(idleTimer);
  if (host) idleTimer = setTimeout(releaseIfIdle, IDLE_MS);
}

function releaseIfIdle() {
  if (jobs.size || downloads.size || [...pages.values()].some((p) => p.pending.length)) return touch();
  release("idle");
}

function release(reason) {
  if (!host) return;
  closeConnection(host);
  host = null;
  appAvailable = undefined;
  endDownloads(reason);
  clearTimeout(idleTimer);
  // Closing our end fires no onDisconnect; end the jobs here.
  const ended = [...jobs.values()];
  jobs.clear();
  active.clear();
  for (const job of ended) {
    if (job.kind === "panel") {
      post(job.port, { type: "done", id: job.id, tokens: 0, cut: 0, stopped: true, cancelled: true });
    } else if (job.kind === "measure") {
      post(job.port, { type: "measured", error: { code: "released" } });
    }
  }
  for (const page of pages.values()) {
    page.pending = [];
    page.busySince = null;
    page.busyTokens = 0;
    // Released on request, pages stop watching for more (which would start the engine again).
    post(page.port, { type: "error", code: "released", reason });
  }
  status = { type: "status", state: "released", reason };
  broadcast(status);
  reportPages();
}

function onHostMessage(connection, message) {
  if (host !== connection) return;
  // Only keeps this service worker alive: not a use of the model.
  if (message.type === "keepalive") return;
  touch();
  switch (message.type) {
    case "status":
      status = { ...message, engine: connection.kind };
      broadcast(status);
      // The first one tells how many batches the engine runs at once.
      schedule();
      return;
    case "options":
      options = { ...message, engine: connection.kind };
      broadcast(options);
      return;
    case "download":
      if (message.state === "running") downloads.add(message.model);
      else downloads.delete(message.model);
      broadcast(message);
      return;
  }
  const job = jobs.get(message.id);
  if (!job) return;
  const finished = message.type === "done" || message.type === "error";
  if (finished) {
    jobs.delete(job.id);
    active.delete(job);
  }
  if (job.kind === "panel") {
    post(job.port, message);
  } else if (job.kind === "measure") {
    if (finished) post(job.port, { type: "measured", error: message.type === "error" ? message : null });
  } else {
    onBatchMessage(job, message);
  }
  if (finished) schedule();
  reportPages();
}

function onBatchMessage(job, message) {
  const page = pages.get(job.tabId);
  if (message.type === "segment") {
    const item = job.items[message.index];
    // A stopped batch's: its page may be another one by now, in the same tab.
    if (job.cancelled) return;
    if (item) {
      item.done = true;
      post(page?.port, { type: "segment", sid: item.sid, text: message.text });
    }
    // The in-browser engine tells each segment's tokens; the app's host only the batch's.
    if (message.tokens > 0 && !job.cancelled) {
      job.counted += message.tokens;
      countTokens(page, message.tokens);
    }
    return;
  }
  // The batch starts once the model is loaded: the speed leaves the loading out.
  if (message.type === "started") {
    job.started = true;
    if (page) page.busySince ??= performance.now();
  }
  if (message.type !== "done" && message.type !== "error") return;
  if (!page) return;
  if (message.type === "done" && !job.cancelled) countTokens(page, message.tokens - job.counted);
  // The speed counts from the start of the page's batches running together.
  if (![...jobs.values()].some((j) => j.kind === "page" && j.tabId === job.tabId)) {
    page.busySince = null;
    page.busyTokens = 0;
  }
  if (job.cancelled) return;
  // A failed batch stops the page's other batches too, which would otherwise end it as done.
  if (message.type === "error") {
    stopPage(job.tabId);
    post(page.port, { type: "error", code: message.code, message: message.message });
    return;
  }
  const undone = job.items.filter((item) => !item.done);
  if (undone.length && !message.cancelled) {
    // Cut short otherwise; the same batch would stop again. Resume in the page tries again.
    stopPage(job.tabId);
    post(page.port, { type: "error", code: "failed", message: "the translation stopped early" });
    return;
  }
  // Paragraphs not translated because the batch was cancelled (a panel translation
  // interrupted it, or the model changed) go back to the front of the queue. Batches
  // interrupted together come back one by one: their paragraphs go back in the page's order.
  for (const item of undone) item.requeued = true;
  page.pending.unshift(...undone);
  let front = 0;
  while (front < page.pending.length && page.pending[front].requeued) front++;
  page.pending.splice(0, front, ...page.pending.slice(0, front).sort((a, b) => a.sid - b.sid));
  reportPage(page);
}

/** Adds generated tokens to a page's count, and tells it its speed (prompts included). */
function countTokens(page, tokens) {
  if (!page || !(tokens > 0) || page.busySince == null) return;
  page.busyTokens += tokens;
  const seconds = (performance.now() - page.busySince) / 1000;
  if (seconds > 0) post(page.port, { type: "speed", tokensPerSecond: page.busyTokens / seconds });
}

function failAll(error) {
  const ended = [...jobs.values()];
  jobs.clear();
  active.clear();
  for (const job of ended) {
    if (job.kind === "panel") post(job.port, { type: "error", id: job.id, ...error });
    else if (job.kind === "measure") post(job.port, { type: "measured", error });
  }
  for (const page of pages.values()) {
    page.pending = [];
    page.busySince = null;
    page.busyTokens = 0;
    post(page.port, { type: "error", ...error });
  }
  reportPages();
}

/** Ends the in-browser engine's downloads in the panels, when its document goes. */
function endDownloads(message) {
  for (const model of downloads) broadcast({ type: "download", model, state: "error", message });
  downloads.clear();
}

/** Whether page batches run side by side on the in-browser engine: the panel's setting. */
let parallelPages = true;
chrome.storage.local
  .get({ parallelPages: true })
  .then((saved) => (parallelPages = saved.parallelPages !== false))
  .catch(() => {});

/**
 * How many page batches the host runs at once: one until the in-browser engine tells, and one
 * with the panel's setting off.
 */
const batchSlots = () =>
  parallelPages && host?.kind === "browser" && status.engine === "browser" && status.slots > 1 ? status.slots : 1;

/** Takes the next paragraphs of `page`, in order, up to these limits (at least one). */
function take(page, maxSegments, maxChars) {
  const items = [];
  let chars = 0;
  while (page.pending.length && items.length < maxSegments && (chars < maxChars || !items.length)) {
    const item = page.pending.shift();
    chars += item.text.length;
    items.push(item);
  }
  return items;
}

function startBatch(tabId, page, items) {
  const job = { id: nextId++, kind: "page", tabId, items, cancelled: false, counted: 0 };
  jobs.set(job.id, job);
  active.add(job);
  sendHost({
    type: "translate_segments",
    id: job.id,
    segments: items.map((item) => item.text),
    target: page.target,
    style: page.style || undefined,
  });
}

/**
 * Starts page batches while the host has room for them and no panel translation (or measurement)
 * runs. One at a time, a batch is the next paragraphs, each with the ones before as history.
 * Side by side, a page's batches run in rounds: the next paragraphs are dealt among them in turn
 * (the first takes 1, 5, 9…, the second 2, 6, 10…), so that those translated at once are next to
 * each other and the page fills from the top, and the next round waits for the last batch of this
 * one. A batch's history is then the paragraphs a few before, not the one just before.
 */
function schedule() {
  if ([...active].some((job) => job.kind !== "page")) return;
  if (![...pages.values()].some((page) => page.pending.length)) return;
  // How many batches run at once is known from the connection's first status (the in-browser
  // engine tells its slots): until then nothing is sent, so that the first round is dealt too.
  if (!host?.kind || status.engine !== host.kind) {
    if (!host) connectHost();
    return;
  }
  const slots = batchSlots();
  while (active.size < slots) {
    // The page whose translation started last first (another can have found more to translate).
    const entry = [...pages].filter(([, page]) => page.pending.length).sort((a, b) => (b[1].startedAt ?? 0) - (a[1].startedAt ?? 0))[0];
    if (!entry) return;
    const [tabId, page] = entry;
    if (slots === 1) {
      startBatch(tabId, page, take(page, BATCH_SEGMENTS, BATCH_CHARS));
      continue;
    }
    // A round takes all the slots: after the last batch running, of any page.
    if (active.size) return;
    const round = take(page, slots * BATCH_SEGMENTS, slots * BATCH_CHARS);
    const batches = Array.from({ length: Math.min(slots, round.length) }, () => []);
    round.forEach((item, i) => batches[i % batches.length].push(item));
    for (const items of batches) startBatch(tabId, page, items);
    return;
  }
}

/** Tells a page when all its paragraphs are translated. */
function reportPage(page) {
  const busy = [...jobs.values()].some((job) => job.kind === "page" && pages.get(job.tabId) === page);
  // With the number of segments messages taken, so that one sent meanwhile is not taken as done.
  if (!busy && !page.pending.length) post(page.port, { type: "idle", received: page.received });
}

function broadcast(message) {
  for (const port of panels) post(port, message);
}

/** The tabs whose page translation runs: paragraphs waiting, or a batch at the engine. */
function runningPages() {
  return [...pages]
    .filter(([tabId, page]) => page.pending.length || [...jobs.values()].some((j) => j.kind === "page" && j.tabId === tabId && !j.cancelled))
    .map(([tabId]) => tabId);
}

let reportedPages = "";
/** Tells the panels which tabs are translating, when that changes (their page button stops it). */
function reportPages(port = null) {
  const running = runningPages();
  const key = running.join(",");
  if (port) post(port, { type: "pages", running });
  else if (key !== reportedPages) broadcast({ type: "pages", running });
  reportedPages = key;
  for (const [tabId, page] of pages) reportWorking(tabId, page);
}

/**
 * Tells a page which of its runs the host is translating, when that changes: the first not done
 * of each batch it runs (a batch goes in order), which the page marks.
 */
function reportWorking(tabId, page) {
  const sids = [...active]
    .filter((job) => job.kind === "page" && job.tabId === tabId && job.started && !job.cancelled)
    .map((job) => job.items.find((item) => !item.done)?.sid)
    .filter((sid) => sid != null);
  const key = sids.join(",");
  if (key === page.working) return;
  page.working = key;
  post(page.port, { type: "working", sids });
}

// ---- Panels ----

function onPanelMessage(port, message) {
  switch (message.type) {
    case "hello":
      post(port, status);
      if (options) post(port, options);
      reportPages(port);
      reportEngine(port);
      if (host) sendHost({ type: "options" });
      break;
    case "translate": {
      // Starts at once: the host stops whatever runs and reports it done (see onBatchMessage).
      const job = { id: nextId++, kind: "panel", port };
      jobs.set(job.id, job);
      active.clear();
      active.add(job);
      post(port, { type: "accepted", id: job.id });
      sendHost({ type: "translate", id: job.id, text: message.text, target: message.target, style: message.style });
      // The page batches it interrupts are no longer on their runs.
      reportPages();
      break;
    }
    case "cancel":
      cancelPanel(port);
      break;
    case "configure":
    case "options":
    case "status":
      sendHost(message);
      break;
    // The in-browser engine's models, connecting to it if it was released (or not started yet).
    case "download":
    case "delete":
      (async () => {
        const kind = host ? host.kind : await chooseEngine();
        if (kind === "browser" || kind === null) sendHost(message);
      })();
      break;
    case "set_engine":
      // Saved, then the current engine is released and the new one asked for its options.
      chrome.storage.local.set({ engine: message.engine }).then(() => {
        appAvailable = undefined;
        release("engine");
        sendHost({ type: "options" });
        reportEngine();
      });
      break;
    case "measure":
      // The in-browser engine measures the GPU and the CPU again; page batches wait for it.
      (async () => {
        // While the connection starts (as after the panel's `configure`), its kind is not known yet.
        if ((host?.kind ?? (await chooseEngine())) !== "browser") {
          post(port, { type: "measured", error: { code: "failed", message: "not the in-browser engine" } });
          return;
        }
        const job = { id: nextId++, kind: "measure", port };
        jobs.set(job.id, job);
        active.clear();
        active.add(job);
        sendHost({ type: "measure", id: job.id });
        reportPages();
      })();
      break;
    case "release":
      release("requested");
      break;
    case "stop_page": {
      const page = pages.get(message.tabId);
      stopPage(message.tabId);
      post(page?.port, { type: "stopped", reason: "panel" });
      break;
    }
    case "translate_page":
      translatePage(message.tabId).then(
        () => post(port, { type: "page_started" }),
        (e) => post(port, { type: "page_failed", message: String(e?.message ?? e) }),
      );
      break;
  }
}

// ---- Page translation ----

async function translatePage(tabId) {
  // The extension's PDF viewer runs page.js itself.
  const viewer = chrome.runtime.getURL("pdf.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [tabId] }).catch(() => []);
  if (contexts.some((c) => c.documentUrl?.startsWith(viewer))) {
    await chrome.runtime.sendMessage({ type: "pdf_translate", tabId }).catch(() => {});
    return;
  }
  // A tab whose address does not show is one the extension has no access to. The browser
  // refuses a script for it, saying why (a browser page, a site not allowed), unless the user
  // withholds access the extension was given ("on click"): the script is then held back, neither
  // run nor refused, and the panel would wait for nothing. So a script that does nothing goes
  // first, and one still held after a moment is refused here, in the words of the browser's
  // refusal for a site not allowed, which the panel knows.
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === undefined) {
    const held = new Error("Cannot access contents of the page. The extension must request permission to access its site.");
    const refused = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func: () => true }).then(
        () => null,
        (e) => e,
      ),
      new Promise((resolve) => setTimeout(() => resolve(held), 1000)),
    ]);
    if (refused) throw refused;
  }
  // A PDF shows in the browser's own viewer, which no extension can enter: its file is read in
  // the tab (as the page would read it, with its cookies) and shown in the extension's viewer.
  const key = crypto.randomUUID();
  const [{ result: pdf } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: readPdf, args: [key, PDF_CHUNK] });
  if (pdf) {
    await openPdfViewer(tabId, key, pdf);
    return;
  }
  // page.js asks for the display language's messages ("ui_messages") when it starts.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["i18n.js", "page.js"] });
}

/**
 * Translates the page the menu was opened on. A click inside the browser's PDF viewer may come
 * without its tab (an id of -1, where the viewer is a guest in the tab), and then gives no
 * access to the tab either. The tab is then the active one; and unless the extension has access
 * to the PDF's site, its viewer opens with the PDF's address from the click and reads it itself,
 * asking for the access it needs.
 */
async function translateFromMenu(info, tab) {
  if (tab?.id >= 0) return translatePage(tab.id);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id == null) return;
  const url = [info.frameUrl, info.pageUrl].find((u) => /^(?:https?|file):/.test(u ?? ""));
  // Asked first, not found out by trying: where the user withholds the extension's access
  // ("on click"), the browser holds a script for the tab back instead of refusing it, and
  // nothing would happen.
  if (!url || (await siteAccess(url))) {
    try {
      return await translatePage(active.id);
    } catch (e) {
      if (!url) throw e;
    }
  }
  await openPdfViewer(active.id, crypto.randomUUID(), { url, error: "no access to the tab" });
}

/** Whether the extension may read the site of `url` (http or https) now. */
async function siteAccess(url) {
  const { protocol, hostname } = new URL(url);
  if (!/^https?:$/.test(protocol)) return false;
  return chrome.permissions.contains({ origins: [`${protocol}//${hostname}/*`] }).catch(() => false);
}

/** A PDF comes from its tab in pieces of this many bytes: a message has a size limit. */
const PDF_CHUNK = 4 * 1024 * 1024;

/**
 * Runs in the tab: sends its PDF to the background in pieces (`pdf_chunk` messages, each
 * answered before the next), for the viewer's store under `key`. Returns { url, size, chunks },
 * { url, error } if the file could not be read, or null if the tab shows no PDF.
 */
async function readPdf(key, chunkSize) {
  if (document.contentType !== "application/pdf") return null;
  const url = location.href;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let chunks = 0;
    for (let at = 0; at < bytes.length; at += chunkSize) {
      const piece = bytes.subarray(at, at + chunkSize);
      let binary = "";
      for (let i = 0; i < piece.length; i += 0x8000) binary += String.fromCharCode.apply(null, piece.subarray(i, i + 0x8000));
      const stored = await chrome.runtime.sendMessage({ type: "pdf_chunk", key, index: chunks++, url, data: btoa(binary) });
      if (!stored) throw new Error("not stored");
    }
    return { url, size: bytes.length, chunks };
  } catch (e) {
    // The viewer then reads it from its address (a file needs the access to file URLs).
    return { url, error: String(e?.message ?? e) };
  }
}

/** Keeps a piece of a PDF that `readPdf` sent from its tab. */
async function storePdfChunk(message) {
  if (message.index === 0) await pdfStore.begin(message.key, message.url);
  const binary = atob(message.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await pdfStore.putChunk(message.key, message.index, bytes.buffer);
}

/** Opens the viewer next to the tab, which translates the PDF as it shows it. */
async function openPdfViewer(tabId, key, pdf) {
  // Without the file here, the viewer reads it from its address, and keeps it then.
  if (!pdf.error) await pdfStore.finish(key, pdf.size, pdf.chunks).catch(() => {});
  const tab = await chrome.tabs.get(tabId);
  const url = chrome.runtime.getURL(`pdf.html?${new URLSearchParams({ src: pdf.url, key })}`);
  await chrome.tabs.create({ url, windowId: tab.windowId, index: tab.index + 1, openerTabId: tabId });
}

function onPageMessage(port, message) {
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  switch (message.type) {
    case "segments": {
      // A page translation that starts (not more paragraphs of a running one) stops those of
      // other tabs: the user has moved on. They can resume from their own page.
      if (message.start) {
        for (const [other, page] of pages) {
          if (other === tabId) continue;
          const running = page.pending.length || [...jobs.values()].some((j) => j.kind === "page" && j.tabId === other);
          if (!running) continue;
          stopPage(other);
          post(page.port, { type: "stopped" });
        }
      }
      const page = pages.get(tabId) ?? { port, pending: [], busySince: null, busyTokens: 0, received: 0 };
      page.received = page.port === port ? page.received + 1 : 1;
      if (message.start) page.startedAt = performance.now();
      page.port = port;
      page.target = message.target;
      page.style = message.style;
      page.pending.push(...message.items);
      pages.set(tabId, page);
      schedule();
      reportPages();
      break;
    }
    case "cancel":
      stopPage(tabId);
      break;
    case "prioritize": {
      // Paragraphs the user scrolled to go first, in the order given.
      const page = pages.get(tabId);
      if (!page) break;
      const order = new Map(message.sids.map((sid, i) => [sid, i]));
      const first = page.pending.filter((item) => order.has(item.sid));
      first.sort((a, b) => order.get(a.sid) - order.get(b.sid));
      page.pending = [...first, ...page.pending.filter((item) => !order.has(item.sid))];
      break;
    }
  }
}

function stopPage(tabId) {
  const page = pages.get(tabId);
  if (page) page.pending = [];
  for (const job of jobs.values()) {
    if (job.kind !== "page" || job.tabId !== tabId) continue;
    job.cancelled = true;
    // The app's host stops its one job, whatever the id; the in-browser engine this one.
    if (active.has(job)) sendHost({ type: "cancel", id: job.id });
  }
  reportPages();
}

/** Stops the panel's translation if it runs. */
function cancelPanel(port) {
  const job = [...active].find((j) => j.kind === "panel" && j.port === port);
  if (job) sendHost({ type: "cancel", id: job.id });
}

// ---- Wiring ----

/** Whether `sender` is one of this extension's pages (the panel), not a content script in a page. */
const fromExtensionPage = (sender) => !!sender?.url?.startsWith(chrome.runtime.getURL(""));

chrome.runtime.onConnect.addListener((port) => {
  // Each port only from where it belongs: page.js runs in web pages' processes, whose ports
  // must not act as the panel or the engine.
  const sender = port.sender;
  if (port.name === "panel" && fromExtensionPage(sender)) {
    panels.add(port);
    port.onMessage.addListener((message) => onPanelMessage(port, message));
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      cancelPanel(port);
      // Its jobs end at the host; what they still send goes nowhere.
      for (const job of jobs.values()) if (job.port === port) job.port = null;
    });
  } else if (port.name === "engine" && sender?.url === chrome.runtime.getURL("engine.html") && !sender.tab) {
    // The in-browser engine's document, opened by openEngine.
    if (engineConnected) {
      engineConnected(port);
      engineConnected = null;
    } else {
      port.disconnect();
    }
  } else if (port.name === "page" && sender?.tab && sender.frameId === 0) {
    port.onMessage.addListener((message) => onPageMessage(port, message));
    port.onDisconnect.addListener(() => {
      const tabId = port.sender?.tab?.id;
      const page = pages.get(tabId);
      if (page?.port !== port) return;
      stopPage(tabId);
      pages.delete(tabId);
      reportPages();
    });
  } else {
    port.disconnect();
  }
});

// The display language, read again when the panel changes it.
let languageReady = loadUiLanguage();
chrome.storage.local.onChanged.addListener((changes) => {
  // From the next batch on.
  if (changes.parallelPages) parallelPages = changes.parallelPages.newValue !== false;
  if (!changes.uiLanguage) return;
  languageReady = loadUiLanguage().then(() => {
    for (const { id, message } of MENUS) chrome.contextMenus.update(id, { title: t(message) }).catch(() => {});
  });
});

chrome.runtime.onInstalled.addListener(() => {
  languageReady.then(async () => {
    // Those of the version before stay over an update, and would keep their contexts.
    await chrome.contextMenus.removeAll();
    for (const { id, message, contexts } of MENUS) chrome.contextMenus.create({ id, title: t(message), contexts });
  });
});

// The viewer's PDFs not opened for long go, also when no other PDF is opened to make room for.
chrome.runtime.onStartup.addListener(() => {
  pdfStore.prune().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pdf_chunk") {
    // From readPdf in a tab, which waits for the answer before it sends the next piece.
    if (!sender?.tab || typeof message.data !== "string") return false;
    storePdfChunk(message).then(
      () => sendResponse(true),
      () => sendResponse(false),
    );
    return true;
  }
  if (message?.type !== "ui_messages") return false;
  languageReady.then(() => sendResponse(uiMessages ?? null));
  return true;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_PAGE) {
    translateFromMenu(info, tab).catch((e) => console.warn("translate page:", e));
    return;
  }
  if (info.menuItemId !== MENU_SELECTION || !info.selectionText) return;
  // Must be called while handling the click, before anything asynchronous.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  requestPanel(tab.windowId, info.selectionText, "menu");
});

/**
 * Asks the panel of a window to translate `text`, or with none to take the cursor only. The panel
 * picks this up when it opens, or right away if it is open already.
 */
function requestPanel(windowId, text, from) {
  chrome.storage.session.set({ request: { windowId, text, from, at: Date.now() } });
}

/**
 * The text selected in a tab where the keyboard is: "" when nothing is selected there, when that
 * is a frame the extension cannot enter (another site's, a PDF), or when it cannot enter the tab.
 */
async function selectedText(tabId) {
  const results = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      // A page still loading does not keep the panel waiting.
      injectImmediately: true,
      func: () => {
        const focusedIn = (doc) => {
          let el = doc.activeElement;
          while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
          return el;
        };
        // The keyboard is in this frame when each frame above has it on this one's way. Focus is
        // not asked: opening the panel takes it, usually before this runs.
        try {
          for (let w = window; w !== w.top; w = w.parent) {
            if (focusedIn(w.parent.document) !== w.frameElement) return "";
          }
        } catch {
          return ""; // Below a frame of another site.
        }
        const el = focusedIn(document);
        if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement || el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement) {
          return ""; // In a frame below, which answers for itself.
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          // Masked fields: passwords, and boxes masked by CSS (PIN fields). Their document
          // selection is the masking dots.
          const security = getComputedStyle(el).getPropertyValue("-webkit-text-security");
          if (el.type === "password" || (security && security !== "none")) return "";
          // A text box's selection is not the document's.
          if (el.selectionStart != null) return el.value.slice(el.selectionStart, el.selectionEnd).trim();
        }
        return getSelection()?.toString().trim() ?? "";
      },
    })
    .catch(() => []);
  return results.find((r) => r.result)?.result ?? "";
}

// The shortcuts (manifest `commands`), which grant activeTab like the context menu.
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id == null) return;
  if (command === "translate-page") {
    translatePage(tab.id).catch(() => {});
  } else if (command === "translate-selection") {
    // Must be called while handling the shortcut, before anything asynchronous.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    selectedText(tab.id).then((text) => requestPanel(tab.windowId, text, "shortcut"));
  }
});
