// Side panel: translates text through the background (background.js), which holds the
// connection to the engine (the desktop app's browser host, or the in-browser engine), and shows
// the translation as it streams in.
// It also starts page translation (page.js) and holds the extension's settings.
// Texts come from i18n.js (`t`), in the display language chosen here or the browser's.

// Target languages, as in the app: Japanese ⇄ English, the model's 53 languages, and easy
// Japanese (experimental). Names come from the app's locale file (lang_* messages).
const TARGETS = [
  "auto", "ja", "en", "zh-hans", "zh-hant", "ko", "ar", "az", "be", "bg", "bn", "ca", "ceb", "de",
  "es", "et", "eu", "fa", "fr", "gu", "he", "hi", "hr", "hu", "hy", "id", "it", "jv", "ka", "kk",
  "km", "lt", "lv", "ml", "mr", "ms", "my", "ne", "nl", "pa", "pl", "ru", "si", "sk", "sl", "sr",
  "sw", "ta", "te", "th", "tl", "ur", "uz", "vi", "ja(easy)",
];
const STYLES = ["", "polite", "plain"];
const PAGE_MODES = ["replace", "below"];
const ENGINES = ["auto", "app", "browser"];

const $ = (id) => document.getElementById(id);
const langName = (code) => t(`lang_${code.replaceAll("-", "_").replace("(easy)", "_easy")}`);

let port = null;
/** The engine in use, from its status and options: `app` or `browser`. */
let engine = "app";
/** The engine the automatic setting uses (`app` or `browser`), or null when another is set. */
let autoEngine = null;
/** Whether the in-browser engine is measuring its devices for the button. */
let measuring = false;
// The model and device chosen here for each engine, by storage key ("" is the default: the
// app's choice, or the first model downloaded); the background sends them whenever it starts
// the engine.
const choices = { choices: { model: "", device: "" }, browserChoices: { model: "", device: "", threads: 0 } };
const choiceKey = () => (engine === "browser" ? "browserChoices" : "choices");
/** The in-browser engine's downloads, by model: its latest `download` message. */
const downloads = {};
let licenseAccepted = false;
/** The model to download once the license is accepted. */
let pendingDownload = null;
/** The translation shown: true while waiting for the background to accept it, then its id. */
let currentId = null;
/** When its first text arrived and how many pieces came since (about one token each), for the speed. */
let firstTextAt = null;
let streamTokens = 0;
/** The progress line without the speed, while translating. */
let progressBase = null;
let speedShownAt = 0;
let outputNode = document.createTextNode("");
// What the status line, the progress line, and the notice show, kept to show it again when the
// display language changes. Texts are functions giving them in the current language.
let shownStatus = null;
let shownOptions = null;
let progress = () => "";
let notice = null;

$("output").append(outputNode);

// ---- Settings ----

$("target").addEventListener("change", () => {
  chrome.storage.local.set({ target: $("target").value });
  updateStyleVisibility();
});
$("style").addEventListener("change", () => chrome.storage.local.set({ style: $("style").value }));
$("pageMode").addEventListener("change", () => chrome.storage.local.set({ pageMode: $("pageMode").value }));
for (const id of ["pageMarks", "pageNearby", "parallelPages", "checkUpdates"]) {
  $(id).addEventListener("change", () => chrome.storage.local.set({ [id]: $(id).checked }));
}
$("uiLanguage").addEventListener("change", () => chrome.storage.local.set({ uiLanguage: $("uiLanguage").value }));
$("engine").addEventListener("change", () => {
  shownOptions = null;
  send({ type: "set_engine", engine: $("engine").value });
});
// Applied here as in panels of other windows (and in the background, for its menus).
chrome.storage.local.onChanged.addListener(async (changes) => {
  if (changes.engine) $("engine").value = changes.engine.newValue ?? "auto";
  if (!changes.uiLanguage) return;
  const uiLanguage = await loadUiLanguage();
  applyLanguage();
  $("uiLanguage").value = uiLanguage;
});

for (const id of ["model", "device", "threads"]) {
  $(id).addEventListener("change", () => {
    const key = choiceKey();
    choices[key][id] = id === "threads" ? Number($(id).value) || 0 : $(id).value;
    chrome.storage.local.set({ [key]: choices[key] });
    const { model, device, threads } = choices[key];
    send({ type: "configure", model: model || undefined, device: device || undefined, threads: threads || undefined });
    if (id === "device") updateThreadsVisibility();
  });
}

/** The thread count applies to the in-browser engine on the CPU only, so it shows only then. */
function updateThreadsVisibility() {
  $("threadsRow").hidden = !(engine === "browser" && $("device").value === "cpu");
}

$("measure").addEventListener("click", () => {
  // Automatic then uses the faster device.
  $("device").value = "";
  $("device").dispatchEvent(new Event("change"));
  measuring = true;
  renderMeasure();
  send({ type: "measure" });
});

$("resetSettings").addEventListener("click", async () => {
  if (!confirm(t("resetSettingsConfirm"))) return;
  await chrome.storage.local.clear();
  // The in-browser engine's device measurement (this extension's localStorage).
  localStorage.clear();
  // The background releases the engine and connects to the automatic one.
  send({ type: "set_engine", engine: "auto" });
  location.reload();
});

$("licenseLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: t("licenseUrl") });
});
$("appGuide").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: t("appGuideUrl") });
});
$("licenseAccept").addEventListener("click", () => {
  licenseAccepted = true;
  chrome.storage.local.set({ licenseAccepted });
  if (pendingDownload) send({ type: "download", model: pendingDownload });
  pendingDownload = null;
  renderBrowserModels();
});

// ---- Keyboard shortcuts ----
// An extension can read its keys but not set them (chrome.commands has no setter), so the panel
// shows them and links to the browser's page where they are set.

/** The commands' names in the display language: the manifest's follow the browser's. */
const COMMAND_LABELS = {
  _execute_action: "commandOpenPanel",
  "translate-page": "translatePage",
  "translate-selection": "commandTranslateSelection",
};
const SHORTCUTS_PAGE = navigator.userAgentData?.brands?.some((b) => b.brand === "Microsoft Edge")
  ? "edge://extensions/shortcuts"
  : "chrome://extensions/shortcuts";
/** The commands and their keys, as chrome.commands.getAll gives them. */
let commands = [];

async function loadShortcuts() {
  commands = await chrome.commands.getAll();
  renderShortcuts();
}

function renderShortcuts() {
  const cells = commands.flatMap(({ name, description, shortcut }) => {
    const label = document.createElement("span");
    label.textContent = COMMAND_LABELS[name] ? t(COMMAND_LABELS[name]) : description;
    const key = document.createElement(shortcut ? "kbd" : "span");
    key.textContent = shortcut || t("shortcutNone");
    if (!shortcut) key.className = "none";
    return [label, key];
  });
  $("shortcutRows").replaceChildren(...cells);
}

$("shortcutsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: SHORTCUTS_PAGE });
});
// The keys change on the browser's page: they are read again when the panel is back in use.
window.addEventListener("focus", loadShortcuts);
$("settings").addEventListener("toggle", () => $("settings").open && loadShortcuts());

function updateStyleVisibility() {
  // Style applies to Japanese only; "auto" may translate into Japanese.
  const target = $("target").value;
  $("style").hidden = !(target === "ja" || target === "auto");
}

/** Shows every text in the display language: at startup and when the language changes. */
function applyLanguage() {
  document.documentElement.lang = uiLocale();
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);

  fill($("target"), TARGETS, langName);
  fill($("style"), STYLES, (style) => t(`style_${style || "default"}`));
  fill($("pageMode"), PAGE_MODES, (mode) => t(`pageMode_${mode}`));
  renderEngineSelect();
  const browser = UI_LANGUAGES[chrome.i18n.getMessage("locale")] ?? "";
  fill($("uiLanguage"), ["auto", ...Object.keys(UI_LANGUAGES)], (lang) =>
    lang === "auto" ? t("uiLanguageAuto", browser) : UI_LANGUAGES[lang],
  );
  if (shownOptions) {
    // Keeps the choices made since the host's options arrived.
    const model = $("model").value;
    const device = $("device").value;
    renderOptions(shownOptions);
    $("model").value = model;
    $("device").value = device;
  }
  if (shownStatus) renderStatus(shownStatus);
  renderEngineTexts();
  renderShortcuts();
  renderPageButton();
  setTranslating(currentId !== null);
  $("progress").textContent = progress();
  if (notice) renderNotice();
  if (updateNotice) renderUpdateNotice();
}

/** Fills `select` with `values`, labelled by `label`, keeping its selection. */
function fill(select, values, label) {
  const selected = select.value;
  select.replaceChildren(...values.map((value) => new Option(label(value), value)));
  if (values.includes(selected)) select.value = selected;
}

// ---- Actions ----

$("translate").addEventListener("click", () => {
  if (currentId !== null) {
    send({ type: "cancel" });
  } else {
    translate($("source").value);
  }
});
$("source").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    translate($("source").value);
  }
});
$("release").addEventListener("click", () => send({ type: "release" }));
$("translatePage").addEventListener("click", () => {
  if (activeTabId !== null && runningPages.has(activeTabId)) {
    send({ type: "stop_page", tabId: activeTabId });
  } else {
    translatePage();
  }
});

/** The active tab of this panel's window, and the tabs whose page translation runs. */
let activeTabId = null;
let runningPages = new Set();
async function updateActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  renderPageButton();
}
chrome.tabs.onActivated.addListener(updateActiveTab);
updateActiveTab();

function renderPageButton() {
  const running = activeTabId !== null && runningPages.has(activeTabId);
  const button = $("translatePage");
  button.textContent = t(running ? "stopPage" : "translatePage");
  button.title = t(running ? "stopPageTitle" : "translatePageTitle");
  button.classList.toggle("running", running);
}

async function translatePage() {
  hideNotice();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) send({ type: "translate_page", tabId: tab.id });
}
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(outputNode.data);
  $("copy").textContent = t("copied");
  setTimeout(() => ($("copy").textContent = t("copy")), 1200);
});

// The display language comes before any text is shown, and the saved choices before the host
// is first contacted.
const ready = Promise.all([
  loadUiLanguage(),
  chrome.storage.local.get({ target: "auto", style: "", pageMode: "replace", pageMarks: true, pageNearby: false, parallelPages: true, checkUpdates: true, engine: "auto", licenseAccepted: false, ...choices }),
]).then(([uiLanguage, saved]) => {
  applyLanguage();
  $("uiLanguage").value = uiLanguage;
  $("target").value = saved.target;
  $("style").value = saved.style;
  $("pageMode").value = saved.pageMode;
  $("pageMarks").checked = saved.pageMarks;
  $("pageNearby").checked = saved.pageNearby;
  $("parallelPages").checked = saved.parallelPages;
  $("checkUpdates").checked = saved.checkUpdates;
  $("engine").value = saved.engine;
  updateStyleVisibility();
  for (const key of Object.keys(choices)) Object.assign(choices[key], saved[key]);
  licenseAccepted = saved.licenseAccepted;
  loadShortcuts();
});

// Text selected in a page arrives through session storage (see requestPanel in background.js),
// for the panel of one window.
const windowId = chrome.windows.getCurrent().then((w) => w.id);
chrome.storage.session.get("request").then(({ request }) => request && ready.then(() => takeRequest(request)));
chrome.storage.session.onChanged.addListener((changes) => {
  const request = changes.request?.newValue;
  if (request) ready.then(() => takeRequest(request));
});

/** When the panel was last shown: opened, or shown again from Chrome's cache. */
let shownAt = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") shownAt = Date.now();
});

/** How long a request waits for its window's panel, which opens within a few seconds. */
const REQUEST_TIMEOUT_MS = 30_000;

async function takeRequest(request) {
  // Not taken in time, so its window's panel did not open: opening it there later must not
  // translate an old selection. Any panel drops it.
  if (Date.now() - (request.at ?? 0) > REQUEST_TIMEOUT_MS) {
    chrome.storage.session.remove("request");
    return;
  }
  if (request.windowId !== (await windowId)) return;
  chrome.storage.session.remove("request");
  // The shortcut pressed while the keyboard was in the panel, shown for a while: the page's
  // selection is an old one, and the panel keeps what it has.
  if (request.from === "shortcut" && document.hasFocus() && Date.now() - shownAt > 1000) return;
  const source = $("source");
  if (request.text) {
    source.value = request.text;
    translate(request.text);
  }
  source.focus();
  source.setSelectionRange(source.value.length, source.value.length);
}

// ---- Talking to the background ----

function connect() {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener(onMessage);
  // The background stops when idle; connect again on the next message.
  port.onDisconnect.addListener(() => {
    port = null;
    if (currentId !== null) finish();
  });
  port.postMessage({ type: "hello" });
}

function send(message) {
  if (!port) connect();
  port.postMessage(message);
}

function translate(text) {
  if (!text.trim()) return;
  hideNotice();
  currentId = true;
  firstTextAt = null;
  streamTokens = 0;
  outputNode.data = "";
  setProgress(() => "");
  $("copy").disabled = true;
  setTranslating(true);
  send({ type: "translate", text, target: $("target").value, style: $("style").value || undefined });
}

function onMessage(message) {
  switch (message.type) {
    case "status":
      renderStatus(message);
      if (message.state === "disconnected" && message.message) {
        showNotice(() =>
          message.engine === "browser"
            ? t("noticeEngineStopped", message.message)
            : setupNeeded(message.message)
              ? t("noticeSetup")
              : t("noticeDisconnected", message.message),
        );
      }
      return;
    case "options":
      renderOptions(message);
      return;
    case "engine":
      autoEngine = message.auto;
      renderEngineSelect();
      return;
    case "measured":
      measuring = false;
      renderMeasure();
      if (message.error && message.error.code !== "released") showNotice(() => errorText(message.error));
      return;
    case "download":
      downloads[message.model] = message;
      renderBrowserModels();
      return;
    case "pages":
      runningPages = new Set(message.running);
      renderPageButton();
      return;
    case "accepted":
      if (currentId === true) currentId = message.id;
      return;
    case "page_failed":
      pageFailed(message.message);
      return;
    case "page_started":
      return;
  }
  if (message.id !== currentId) return;
  switch (message.type) {
    case "started":
      setLiveProgress(() => t("translatingInto", langName(message.target)));
      break;
    case "progress":
      if (message.count > 1) setLiveProgress(() => `${message.index + 1} / ${message.count}`);
      break;
    case "text": {
      const now = performance.now();
      firstTextAt ??= now;
      streamTokens++;
      outputNode.appendData(message.text);
      // The speed, a few times a second.
      if (progressBase && now - speedShownAt > 250) {
        speedShownAt = now;
        $("progress").textContent = progress();
      }
      break;
    }
    case "rewind":
      // Lengths are in UTF-16 code units, like JavaScript strings.
      outputNode.data = outputNode.data.slice(0, message.length);
      break;
    case "done": {
      // Generation speed: the tokens over the time since the first one arrived.
      const seconds = firstTextAt === null ? 0 : (performance.now() - firstTextAt) / 1000;
      const speed = message.tokens > 1 && seconds > 0 ? (message.tokens / seconds).toFixed(1) : null;
      setProgress(() =>
        message.stopped
          ? t("stopped")
          : message.cut > 0
            ? t("doneCut", String(message.cut))
            : speed
              ? t("doneSpeed", String(message.tokens), speed)
              : t("done", String(message.tokens)),
      );
      finish();
      break;
    }
    case "error":
      showNotice(() => errorText(message));
      finish();
      break;
  }
}

function finish() {
  currentId = null;
  setTranslating(false);
  $("copy").disabled = outputNode.data.length === 0;
}

function errorText(message) {
  switch (message.code) {
    case "no_model":
      return engine === "browser" ? t("errorNoModelBrowser") : t("errorNoModel");
    case "model_missing":
      return t("errorModelMissing");
    case "disconnected":
      return setupNeeded(message.message) ? t("noticeSetup") : t("noticeDisconnected", message.message ?? "");
    default:
      return t("errorFailed", message.message ?? message.code);
  }
}

/**
 * Explains why page.js could not be injected, offering the permission for all sites when it
 * would help.
 */
async function pageFailed(error) {
  // The extension may enter a tab after the context menu or one of its shortcuts was used on it
  // (activeTab), until the tab goes to another site. Buttons in the panel do not grant that, and
  // neither does the toolbar button, since it opens the panel (see design.md).
  // Other tabs need the permission for their site. Browser pages, the extension stores, and
  // error pages cannot be entered at all.
  const all = { origins: ["<all_urls>"] };
  const permissionHelps =
    /must request permission/i.test(error ?? "") && !(await chrome.permissions.contains(all).catch(() => false));
  if (!permissionHelps) {
    showNotice(() => t("pageCannotTranslate"));
    return;
  }
  showNotice(
    () => t("pageNotAllowed"),
    () => t("allowAllSites"),
    async () => {
      if (await chrome.permissions.request(all)) translatePage();
    },
  );
}

/** Whether the host could not be started: not registered, or the app was moved. */
function setupNeeded(error) {
  return /not found|forbidden|exited/i.test(error ?? "");
}

// ---- Rendering ----

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;

function renderOptions(options) {
  shownOptions = options;
  engine = options.engine ?? "app";
  renderEngineTexts();
  if (engine === "browser") {
    renderBrowserOptions(options);
    return;
  }
  $("browserModels").hidden = true;
  $("threadsRow").hidden = true;
  renderMeasure();
  const model = $("model");
  model.replaceChildren(new Option(t("followApp", options.app_model ?? t("none")), ""));
  for (const m of options.models) model.add(new Option(`${m.label} (${gb(m.bytes)})`, m.id));
  model.value = options.model ?? "";

  // Automatic as the app measured, such as `Automatic (Vulkan0)`.
  const auto = options.auto_device;
  const deviceName = (setting) =>
    setting === "auto" ? (auto ? t("deviceAutoApp", auto) : t("deviceAuto")) : setting === "cpu" ? "CPU" : setting;
  const device = $("device");
  device.replaceChildren(
    new Option(t("followApp", deviceName(options.app_device)), ""),
    new Option(auto ? t("deviceAutoIs", auto) : t("deviceAuto"), "auto"),
    new Option("CPU", "cpu"),
  );
  for (const d of options.devices) device.add(new Option(`${d.name} — ${d.description}`, d.name));
  device.value = options.device ?? "";
}

/** The in-browser engine's models and devices: those that fit, downloaded or not. */
function renderBrowserOptions(options) {
  const downloaded = options.models.filter((m) => m.downloaded);
  const model = $("model");
  model.replaceChildren(new Option(t("modelAuto", downloaded[0]?.label ?? t("none")), ""));
  for (const m of options.models) {
    model.add(new Option(`${m.label} (${gb(m.bytes)})${m.downloaded ? "" : ` — ${t("notDownloaded")}`}`, m.id));
  }
  model.value = options.model ?? "";
  const device = $("device");
  // Automatic: the faster device measured, or measured on first use.
  device.replaceChildren(new Option(options.auto ? t("deviceAutoIs", options.auto.toUpperCase()) : t("deviceAutoMeasured"), ""));
  for (const d of options.devices) device.add(new Option(`${d.name.toUpperCase()} — ${d.description}`, d.name));
  device.value = options.device && options.device !== "auto" ? options.device : "";
  // Thread counts for the CPU: powers of two up to the logical cores, and the cores.
  const counts = [];
  for (let n = 1; n < options.cores; n *= 2) counts.push(n);
  if (options.cores) counts.push(options.cores);
  const threads = $("threads");
  threads.replaceChildren(new Option(t("threadsAuto"), ""), ...counts.map((n) => new Option(String(n), String(n))));
  threads.value = options.threads ? String(options.threads) : "";
  updateThreadsVisibility();
  renderMeasure();
  renderBrowserModels();
}

/** The in-browser engine's Measure and choose, with the last measurement, when it has a GPU. */
function renderMeasure() {
  const options = shownOptions;
  const shown = engine === "browser" && !!options?.devices?.some((d) => d.name === "gpu");
  $("measureRow").hidden = !shown;
  if (!shown) return;
  const button = $("measure");
  button.disabled = measuring;
  button.textContent = t(measuring ? "measuring" : "measure");
  const m = options.measured;
  if (!m || measuring) {
    $("measured").replaceChildren();
    return;
  }
  // Each device's result stays on one line; the line breaks between them.
  const speed = (name, s) => {
    const span = document.createElement("span");
    span.className = "nowrap";
    span.textContent = s?.seconds > 0 ? t("measuredSpeed", name, String(Math.round(s.generation))) : t("measuredFailed", name);
    return span;
  };
  const [before, after = ""] = t("measured", "\u0001").split("\u0001");
  $("measured").replaceChildren(before, speed("GPU", m.gpu), " · ", speed("CPU", m.cpu), after);
}

/** The engines, with the one the automatic setting uses when it is known. */
function renderEngineSelect() {
  fill($("engine"), ENGINES, (name) =>
    name === "auto" && autoEngine
      ? t(autoEngine === "browser" ? "engineAutoBrowser" : "engineAutoApp")
      : t(`engine${name[0].toUpperCase()}${name.slice(1)}`),
  );
}

/** The in-browser engine's models with their downloads, and the license before the first one. */
function renderBrowserModels() {
  const models = engine === "browser" ? (shownOptions?.models ?? []) : [];
  $("browserModels").hidden = models.length === 0;
  const start = (id) => {
    if (licenseAccepted) {
      send({ type: "download", model: id });
    } else {
      pendingDownload = id;
      renderBrowserModels();
    }
  };
  $("modelRows").replaceChildren(
    ...models.flatMap((m) => {
      const row = document.createElement("div");
      row.className = "model-row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${m.label} (${gb(m.bytes)})`;
      const state = document.createElement("span");
      state.className = "state";
      const button = document.createElement("button");
      button.className = "small";
      const download = downloads[m.id];
      const failed = download?.state === "error";
      if (failed) {
        state.textContent = t("downloadFailed", download.message ?? "");
        state.classList.add("error");
      }
      // A newer version than the file there, which stays in use until Update replaces it.
      let note = null;
      if (m.newer) {
        note = document.createElement("div");
        note.className = "model-note";
        note.textContent = t("newerVersion", m.newer.date);
        note.title = m.newer.change ?? "";
      }
      const buttons = [button];
      if (download?.state === "running" || m.downloading) {
        state.textContent = t("downloading", String(Math.floor((100 * (download?.received ?? 0)) / m.bytes)));
        state.classList.remove("error");
        button.hidden = true;
      } else if (m.downloaded) {
        button.textContent = t("deleteModel");
        button.onclick = () => {
          if (confirm(t("deleteConfirm", m.label))) send({ type: "delete", model: m.id });
        };
        if (m.newer) {
          const update = document.createElement("button");
          update.className = "small";
          update.textContent = t("updateModel");
          update.title = m.newer.change ?? "";
          update.onclick = () => start(m.id);
          buttons.unshift(update);
        }
      } else {
        button.textContent = t("download");
        button.onclick = () => start(m.id);
      }
      row.append(name, state, ...buttons);
      return note ? [row, note] : [row];
    }),
  );
  $("license").hidden = !pendingDownload;
}

/** Texts that depend on the engine in use. */
function renderEngineTexts() {
  $("settingsHint").textContent = t(engine === "browser" ? "settingsHintBrowser" : "settingsHint");
  // The app's host translates one batch at a time anyway.
  $("parallelRow").hidden = engine !== "browser";
  $("appGuide").hidden = engine !== "browser";
  $("appGuide").href = t("appGuideUrl");
  $("release").title = t(engine === "browser" ? "releaseTitleBrowser" : "releaseTitle");
  $("licenseLink").href = t("licenseUrl");
}

function renderStatus(status) {
  shownStatus = status;
  if (status.engine) engine = status.engine;
  let model = [status.model, status.device, status.threads && t("threadsCount", String(status.threads))].filter(Boolean).join(" · ");
  if (engine === "browser" && model) model = t("statusInBrowser", model);
  $("release").disabled = status.state === "released" || status.state === "disconnected";
  switch (status.state) {
    case "ready":
      setStatus(status.gpuUnavailable ? `${model} — ${t("statusGpuUnavailable")}` : model, status.gpuUnavailable);
      break;
    case "loading":
    case "starting":
      setStatus(t("statusLoading", model));
      break;
    case "measuring":
      setStatus(t(status.again ? "statusMeasuringAgain" : "statusMeasuring"));
      break;
    case "no_model":
      setStatus(t(engine === "browser" ? "statusNoModelBrowser" : "statusNoModel"), true);
      break;
    case "released":
      setStatus(status.reason === "idle" ? t("statusReleasedIdle") : t("statusReleased"), false, t("statusReleasedDetail"));
      break;
    case "disconnected":
      setStatus(t("statusDisconnected"), true);
      break;
    default:
      setStatus(status.message ?? t("statusError"), true);
  }
}

function setStatus(text, isError = false, detail = "") {
  $("status").textContent = text;
  $("status").title = detail;
  $("status").classList.toggle("error", isError);
}

/** Shows the progress line; `text` gives it in the current language. */
function setProgress(text) {
  progressBase = null;
  progress = text;
  $("progress").textContent = text();
}

/** The progress line while translating: `base`, then the speed so far once tokens arrive. */
function setLiveProgress(base) {
  setProgress(() => {
    const seconds = firstTextAt === null ? 0 : (performance.now() - firstTextAt) / 1000;
    // The first piece starts the clock.
    const speed = streamTokens > 2 && seconds > 0.2 ? ((streamTokens - 1) / seconds).toFixed(1) : null;
    return speed ? `${base()} · ${t("liveSpeed", speed)}` : base();
  });
  progressBase = base;
}

function setTranslating(translating) {
  const button = $("translate");
  button.textContent = translating ? t("stop") : t("translate");
  button.classList.toggle("primary", !translating);
  button.classList.toggle("danger", translating);
}

/**
 * Shows a notice, with a button running `action` if `label` is given. `text` and `label` give
 * their texts in the current language.
 */
function showNotice(text, label = null, action = null) {
  notice = { text, label, action };
  renderNotice();
}

function renderNotice() {
  $("noticeText").textContent = notice.text();
  const button = $("noticeAction");
  button.hidden = !notice.label;
  button.textContent = notice.label?.() ?? "";
  button.onclick = notice.action;
  $("notice").hidden = false;
}

function hideNotice() {
  notice = null;
  $("notice").hidden = true;
}

// ---- New versions ----

const RELEASES_API = "https://api.github.com/repos/tanakh/plamo-translate-desktop/releases/latest";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The update notice under the header, as `showNotice` takes it; null while hidden. */
let updateNotice = null;

/** `0.5.1` (or `v0.5.1`) → [0, 5, 1]; null for anything else. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

/** Whether version `a` comes after `b` (both parsed). */
function isNewer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** A file of the extension as it is on disk now: an unpacked extension's files are read from there. */
async function packageFile(name) {
  const response = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json();
}

/**
 * Shows a newer version of the extension. Its files on disk come first: when they are newer than
 * those loaded (the app updated itself, with its copy of the extension), a reload loads them.
 * Otherwise, in the extension's own package (its `package.json`), the newest release on GitHub,
 * asked at most once a day unless turned off in the settings.
 */
async function checkForUpdate() {
  const loaded = chrome.runtime.getManifest().version;
  const onDisk = await packageFile("manifest.json").then((m) => m.version, () => loaded);
  if (onDisk !== loaded) {
    showUpdateNotice(() => t("extensionUpdated", onDisk), () => t("extensionReload"), () => chrome.runtime.reload());
    return;
  }
  const standalone = await packageFile("package.json").then((p) => p.kind === "browser-extension", () => false);
  $("checkUpdatesRow").hidden = !standalone;
  const { checkUpdates, updateCheck } = await chrome.storage.local.get({ checkUpdates: true, updateCheck: null });
  if (!standalone || !checkUpdates) return;
  let check = updateCheck;
  // Asked again after a day, or when the clock was set back.
  const age = Date.now() - (check?.at ?? 0);
  if (!check || age < 0 || age >= UPDATE_INTERVAL_MS) {
    try {
      const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(String(response.status));
      const release = await response.json();
      check = { at: Date.now(), version: String(release.tag_name).replace(/^v/, ""), page: String(release.html_url) };
      await chrome.storage.local.set({ updateCheck: check });
    } catch (e) {
      console.warn("update check failed:", e);
      return;
    }
  }
  const latest = parseVersion(check.version);
  const current = parseVersion(loaded);
  if (latest && current && isNewer(latest, current)) {
    showUpdateNotice(() => t("extensionNewVersion", check.version), () => t("extensionDownload"), () =>
      chrome.tabs.create({ url: check.page }),
    );
  }
}

function showUpdateNotice(text, label, action) {
  updateNotice = { text, label, action };
  renderUpdateNotice();
}

function renderUpdateNotice() {
  $("updateText").textContent = updateNotice.text();
  $("updateAction").textContent = updateNotice.label();
  $("updateAction").onclick = updateNotice.action;
  $("updateNotice").hidden = false;
}

$("checkUpdates").addEventListener("change", () => {
  if ($("checkUpdates").checked) {
    checkForUpdate();
  } else {
    updateNotice = null;
    $("updateNotice").hidden = true;
  }
});

// Connect right away, with the saved choices, so the model loads while the user reads.
ready.then(() => send({ type: "options" }));
ready.then(checkForUpdate);
