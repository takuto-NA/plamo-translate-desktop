// The in-browser engine: runs PLaMo 3 Translate with wllama (llama.cpp compiled to WebAssembly,
// on the CPU or through WebGPU) in this offscreen document. The background opens it when the
// extension translates without the desktop app, and closes it after a while without use, which
// frees the model's memory (see background.js).
//
// It speaks the host's protocol (crates/host/src/protocol.rs) over a port named "engine", with
// these differences:
// - The models are the ones that fit WebAssembly's memory, downloaded into the extension's
//   storage (OPFS): `download { model }` fetches one, reporting `download` messages.
// - The devices are `cpu` and `gpu` (WebGPU), and `auto` measures which is faster;
//   `measure { id }` measures again. `configure` also takes `threads` for the CPU.
// - Status and options carry `engine: "browser"`. Status may also be `released` (no model
//   loaded yet) or `measuring`, and carries `slots` (the page batches to send at once),
//   `threads`, `gpuUnavailable`, and `again` (measuring from the button).
// - `segment` carries the segment's generated `tokens`. `keepalive` messages keep the service
//   worker running (see the end of this file).

import { Wllama } from "./vendor/wllama/wllama.js";
import { History, STOP, estimateTokens, prompt, split } from "./translator.js";

/** What the commit of the built-in files changed (see BUILTIN). */
const TARGET_LANG_AUTO = "Update the chat template: switch between Japanese and English by default (target_lang=auto)";

/**
 * The models offered: the app's catalog entries that fit WebAssembly's 4 GB of memory, with the
 * files published when this version was built (2026-11-08). Hugging Face has no version numbers,
 * so a file's version is the commit that last changed it: its date (`published`) and title
 * (`change`). PFN replaces the files now and then (so far only their chat template changed, which
 * this extension does not use) and stops serving old ones, so newer files are looked for on
 * Hugging Face (see refreshCatalog).
 */
const BUILTIN = [
  {
    id: "plamo-3-translate-2b-Q4_K_M",
    label: "2B · Q4_K_M",
    repo: "pfnet/plamo-3-translate-2b-GGUF",
    revision: "228a27cc0bb4f111219963848d50a3127c16ca73",
    bytes: 1807203040,
    published: "2026-11-08T05:48:42Z",
    change: TARGET_LANG_AUTO,
  },
  {
    id: "plamo-3-translate-0.8b-Q4_K_M",
    label: "0.8B · Q4_K_M",
    repo: "pfnet/plamo-3-translate-0.8b-GGUF",
    revision: "e10c327b7a7ce84ffc427cb4b09360b781429fda",
    bytes: 573126848,
    published: "2026-11-08T05:48:24Z",
    change: TARGET_LANG_AUTO,
  },
];
const fileName = (model) => `${model.id}.gguf`;
const modelUrl = (model) => `https://huggingface.co/${model.repo}/resolve/${model.revision}/${fileName(model)}`;

// Smaller than the app's: WebAssembly reads prompts several times slower than native code, so
// shorter pieces and history keep each request quick.
const N_CTX = 4096;
const CHUNK_TOKENS = 512;
const HISTORY_TOKENS = 768;
// Page batches run side by side, up to this many: llama.cpp decodes their tokens together, which
// costs little more per step than one. Each has its own KV cache of N_CTX: with one cache shared
// by all (wllama's default), every step attends over all of them, which made concurrent
// translations several times slower than one alone.
const SLOTS = 4;

// llama.cpp's WebGPU backend requests an adapter without a power preference, which gets the
// integrated GPU beside a discrete one. wllama's worker code passes through
// URL.createObjectURL as a Blob, so it is prefixed here to ask for the high-performance GPU.
const GPU_PREFERENCE = `if (typeof GPU !== "undefined") {
  const request = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = function (options = {}) {
    return request.call(this, { ...options, powerPreference: options.powerPreference ?? "high-performance" });
  };
}
`;
const createObjectURL = URL.createObjectURL;
URL.createObjectURL = (object) =>
  createObjectURL(
    object instanceof Blob && /javascript/.test(object.type) ? new Blob([GPU_PREFERENCE, object], { type: object.type }) : object,
  );

const port = chrome.runtime.connect({ name: "engine" });
// Messages are dropped once the background's end is gone (see the end of this file).
const post = (message) => {
  try {
    port.postMessage(message);
  } catch {}
};

/** The extension's choices ("" or absent: the default; 0 threads: wllama's default). */
let settings = { model: "", device: "auto", threads: 0 };
/**
 * The model in use: { model, device, wllama, gpu, requestedThreads, threads, calls, waiting },
 * or null. `calls` counts the wllama calls running on it (see `complete`).
 */
let loaded = null;
/** Settles when the last load, unload or measurement asked for ends: they run one at a time. */
let loading = Promise.resolve();
/**
 * The running translations by id: { id, kind, controller, running, finished, instance }, the
 * last being the loaded model they translate with.
 */
const jobs = new Map();
// "starting" until the downloaded models are checked (see the end of this file).
let status = { state: "starting" };
const downloads = new Map();

// ---- Storage ----

async function modelsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("models", { create: true });
}

/**
 * "downloaded" (the file of the newest version), "outdated" (a file of another version, used as
 * it is), or null. Downloads only reach the file's name complete, so any file there is whole.
 */
async function localState(model) {
  try {
    const file = await (await (await modelsDir()).getFileHandle(fileName(model))).getFile();
    if (file.size === model.bytes) return "downloaded";
    return file.size > 0 ? "outdated" : null;
  } catch {
    return null;
  }
}

/** Whether there is a file of `model` to load, of whatever version. */
async function isDownloaded(model) {
  return (await localState(model)) !== null;
}

// ---- Catalog ----

const CATALOG_KEY = "catalog";
const CATALOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What the last check on Hugging Face found: { at, models: { [id]: { revision, bytes, published, change } } }. */
function cachedCatalog() {
  try {
    return JSON.parse(localStorage.getItem(CATALOG_KEY) ?? "null");
  } catch {
    return null;
  }
}

/** `2026-11-08T05:48:42.000Z` → `2026-11-08T05:48:42Z`, the form of BUILTIN, so dates compare as strings. */
function timestamp(date) {
  return typeof date === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(date) ? date.replace(/\.\d+Z$/, "Z") : null;
}

/** Whether `found` has the shape a check on Hugging Face gives (the cache could be anything). */
function isValidFound(found) {
  return (
    typeof found?.revision === "string" &&
    /^[0-9a-f]{40}$/.test(found.revision) &&
    Number.isSafeInteger(found.bytes) &&
    found.bytes > 0 &&
    timestamp(found.published) === found.published &&
    typeof found.change === "string"
  );
}

/** The built-in models, each replaced by a newer file found on Hugging Face. */
function currentModels(found) {
  return BUILTIN.map((model) => {
    const newer = found?.[model.id];
    return isValidFound(newer) && newer.published > model.published ? { ...model, ...newer } : model;
  });
}

let MODELS = currentModels(cachedCatalog()?.models);

/**
 * Looks on Hugging Face for newer files of the models, at most once a day. It never holds up a
 * translation, and without a connection nothing changes and nothing is shown: the models
 * downloaded work offline, and the next start of this document tries again.
 */
async function refreshCatalog() {
  const cached = cachedCatalog();
  if (cached && Date.now() - cached.at < CATALOG_INTERVAL_MS) return;
  const found = {};
  try {
    for (const repo of new Set(BUILTIN.map((m) => m.repo))) {
      // `expand` adds the commit that last changed each file.
      const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?expand=true`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const item of await response.json()) {
        const model = BUILTIN.find((m) => m.repo === repo && fileName(m) === item?.path);
        const commit = item?.lastCommit;
        if (!model || item.type !== "file" || !item.lfs || !commit) continue;
        const entry = {
          revision: commit.id,
          bytes: item.lfs.size,
          published: timestamp(commit.date),
          change: String(commit.title ?? "").slice(0, 200),
        };
        if (isValidFound(entry)) found[model.id] = entry;
      }
    }
  } catch (e) {
    console.warn("cannot check Hugging Face for newer models:", e);
    return;
  }
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ at: Date.now(), models: found }));
  } catch {}
  const next = currentModels(found);
  const changed = next.some((m, i) => m.revision !== MODELS[i].revision);
  MODELS = next;
  if (changed) {
    enqueue(setIdleStatus);
    sendOptions();
  }
}

/** The chosen model, else the first one downloaded. */
async function selectedModel() {
  const chosen = MODELS.find((m) => m.id === settings.model);
  if (chosen) return chosen;
  for (const model of MODELS) if (await isDownloaded(model)) return model;
  return null;
}

/** The partial download of `model`, named for its revision so that another is never continued. */
const partName = (model) => `${fileName(model)}.${model.revision.slice(0, 12)}.part`;

/**
 * Removes the partial downloads of `model` other than `keep` (other revisions, older names), and
 * the swap files a write left when its document closed (`.crswap`, which OPFS never uses again).
 * No write may be running for `model`.
 */
async function removeStaleParts(dir, model, keep = null) {
  const stale = [];
  for await (const name of dir.keys()) {
    if (name !== keep && name.startsWith(`${fileName(model)}.`) && (name.endsWith(".part") || name.endsWith(".crswap"))) {
      stale.push(name);
    }
  }
  for (const name of stale) await dir.removeEntry(name).catch(() => {});
}

/**
 * Downloads `model` into OPFS, resuming a partial download. OPFS keeps what a writable stream
 * wrote only once it is closed, so it is closed on failures too: the next try resumes from there.
 * (What arrived since the last close is lost if this document closes meanwhile.)
 */
async function download(model) {
  if (downloads.has(model.id)) return;
  downloads.set(model.id, true);
  const report = (extra) => post({ type: "download", model: model.id, total: model.bytes, ...extra });
  let writable = null;
  try {
    report({ state: "running", received: 0 });
    const dir = await modelsDir();
    const name = partName(model);
    await removeStaleParts(dir, model, name);
    let part = await dir.getFileHandle(name, { create: true });
    let existing = (await part.getFile()).size;
    if (existing > model.bytes) {
      // Not a beginning of this file: start over.
      await dir.removeEntry(name);
      part = await dir.getFileHandle(name, { create: true });
      existing = 0;
    }
    if (existing < model.bytes) {
      const response = await fetch(modelUrl(model), existing ? { headers: { Range: `bytes=${existing}-` } } : {});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A range from elsewhere than the end of the part would corrupt it: start over then.
      const resume = response.status === 206 && (response.headers.get("content-range") ?? "").startsWith(`bytes ${existing}-`);
      if (response.status === 206 && !resume) {
        await response.body?.cancel();
        await dir.removeEntry(name);
        throw new Error("the server sent another range; try again");
      }
      writable = await part.createWritable({ keepExistingData: resume });
      let received = 0;
      if (resume) {
        await writable.seek(existing);
        received = existing;
      }
      let reported = received;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        received += value.length;
        if (received - reported > 8 << 20) {
          reported = received;
          report({ state: "running", received });
        }
      }
      await writable.close();
      writable = null;
      existing = received;
    }
    if (existing !== model.bytes) {
      throw new Error(`downloaded ${existing} bytes instead of ${model.bytes}`);
    }
    // In place of a file of another version, unless a load is reading it: a loaded model is in
    // memory, and stays in use. Should the move fail, the finished part is moved the next time.
    await enqueue(async () => {
      await dir.removeEntry(fileName(model)).catch(() => {});
      await part.move(dir, fileName(model));
    });
    report({ state: "done", received: existing });
  } catch (e) {
    // Keeps what arrived for the next try.
    await writable?.close().catch(() => {});
    report({ state: "error", message: String(e?.message ?? e) });
  } finally {
    downloads.delete(model.id);
  }
  enqueue(setIdleStatus);
  sendOptions();
}

async function deleteModel(model) {
  // After the load in progress, ending the translations that use the model.
  await enqueue(async () => {
    if (loaded?.model.id === model.id) await unload();
  });
  const dir = await modelsDir();
  await dir.removeEntry(fileName(model)).catch(() => {});
  await removeStaleParts(dir, model);
  enqueue(setIdleStatus);
  sendOptions();
}

// ---- Devices ----

/** The WebGPU adapter wllama would get, described, or null without one. */
async function gpuDescription() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
  if (!adapter) return null;
  const info = adapter.info ?? {};
  return info.description || [info.vendor, info.architecture].filter(Boolean).join(" ") || "WebGPU";
}

/** What a measurement is kept for: the GPU and the cores. */
const hardwareOf = (gpu) => `${gpu}; ${navigator.hardwareConcurrency} cores`;

/**
 * The last measurement while it holds for this machine: { device, gpu, cpu }, each speed
 * { seconds, prompt, generation } (seconds null if it did not run), or null.
 */
function savedMeasurement(hardware) {
  try {
    const saved = JSON.parse(localStorage.getItem("measured") ?? "null");
    return saved?.hardware === hardware ? saved : null;
  } catch {
    return null;
  }
}

/** The device `auto` uses: the faster one measured, the CPU without a GPU, or null if not measured. */
const autoDevice = (gpu) => (gpu ? (savedMeasurement(hardwareOf(gpu))?.device ?? null) : "cpu");

// Two texts: the second is timed, and must differ from the first, whose beginning llama.cpp
// would otherwise reuse instead of reading the prompt again.
const WARM_UP_TEXT = "The meeting has been moved to next Monday.";
const MEASURE_TEXT =
  "Large language models have changed how software teams handle documentation. Instead of writing " +
  "every page by hand, engineers now draft the structure, let a model fill in routine sections, and " +
  "spend their time reviewing technical details. This shift raises new questions about accuracy, " +
  "ownership and style, and about who checks the result before it is published.";

/**
 * Seconds for a typical piece (200 prompt and 100 generated tokens) on the loaded model, and the
 * speeds measured.
 */
async function measure() {
  const instance = loaded;
  const run = (text) => complete(instance, { prompt: prompt({ text, target: "ja" }), max_tokens: 64, temperature: 0, stop: [STOP] });
  // The first run includes one-time work, such as compiling GPU kernels.
  await run(WARM_UP_TEXT);
  const { timings } = await run(MEASURE_TEXT);
  return {
    seconds: 200 / timings.prompt_per_second + 100 / timings.predicted_per_second,
    prompt: Math.round(timings.prompt_per_second),
    generation: Math.round(timings.predicted_per_second * 10) / 10,
  };
}

// ---- Loading ----

/** Loads `model` on `device` (in the load chain), unless it is loaded already. */
async function load(model, device) {
  // The thread count matters on the CPU only (also when WebGPU was asked for but not used).
  if (loaded?.model.id === model.id && loaded.device === device && (loaded.gpu || loaded.requestedThreads === settings.threads)) return;
  await unload();
  setStatus({ state: "loading", model: model.label, device: device === "gpu" ? "WebGPU" : "CPU" });
  const file = await (await (await modelsDir()).getFileHandle(fileName(model))).getFile();
  // llama.cpp's messages while loading tell which device it really uses. Kept while loading only:
  // the server logs every request afterwards.
  const lines = [];
  let collecting = true;
  const keep = (...args) => collecting && lines.push(args.join(" "));
  const wllama = new Wllama({ default: "./vendor/wllama/wllama.wasm" }, {
    // The layers offloaded are logged at the debug level, the adapter at the log level.
    logger: { debug: keep, log: keep, info: keep, warn: keep, error: (...args) => (keep(...args), console.error(...args)) },
  });
  try {
    await wllama.loadModel([file], {
      n_ctx: N_CTX * SLOTS,
      n_parallel: SLOTS,
      kv_unified: false,
      // No prompt cache: it would copy the KV state of the prompts a slot moves on from into
      // WebAssembly memory, up to 8 GiB by default, past the 4 GiB there is (allocations then
      // fail). Each batch's requests reuse their own slot's state, which needs no copy.
      cache_ram_mib: 0,
      n_gpu_layers: device === "gpu" ? 999 : 0,
      ...(settings.threads > 0 ? { n_threads: settings.threads } : {}),
    });
  } catch (e) {
    await wllama.exit().catch(() => {});
    throw e;
  }
  collecting = false;
  loaded = {
    model,
    device,
    wllama,
    gpu: device === "gpu" ? usedGpu(lines) : null,
    requestedThreads: settings.threads,
    threads: wllama.getNumThreads(),
    calls: 0,
    waiting: [],
  };
  if (device === "gpu" && !loaded.gpu) console.warn("WebGPU was not used:", lines.filter((l) => /webgpu|offload/i.test(l)).join("\n"));
}

/**
 * The GPU llama.cpp computes on, from its messages while loading (its adapter, and the layers
 * offloaded), or null: without an adapter in wllama's worker it quietly computes on the CPU.
 */
function usedGpu(lines) {
  const adapter = lines.find((l) => l.includes("ggml_webgpu: adapter_info:"));
  const offloaded = lines.map((l) => /offloaded (\d+)\/\d+ layers to GPU/.exec(l)).find(Boolean);
  if (!adapter || !offloaded || offloaded[1] === "0") return null;
  const field = (name) => new RegExp(`${name}: ([^|]*)`).exec(adapter)?.[1].trim();
  return [field("vendor"), field("architecture")].filter(Boolean).join(" ") || "WebGPU";
}

/** The device in use, as the status shows it: `WebGPU (amd rdna-4)`, or `CPU`. */
const deviceLabel = () => (loaded?.gpu ? `WebGPU (${loaded.gpu})` : "CPU");

/**
 * Runs a completion on `instance` (a loaded model), counted so that unloading waits for it, and
 * unloading the instance when wllama crashed.
 */
async function complete(instance, options) {
  instance.calls++;
  try {
    return await instance.wllama.createCompletion(options);
  } catch (e) {
    if (isCrash(e)) crashed(instance, e);
    throw e;
  } finally {
    if (--instance.calls === 0) for (const resolve of instance.waiting.splice(0)) resolve();
  }
}

/** Settles when no wllama call runs on `instance`, or after `ms` in case one never ends. */
const settled = (instance, ms) =>
  instance.calls === 0
    ? Promise.resolve()
    : Promise.race([new Promise((resolve) => instance.waiting.push(resolve)), new Promise((resolve) => setTimeout(resolve, ms))]);

/** A WebAssembly abort (out of memory, a lost GPU device, a failed assertion) kills the module. */
const isCrash = (e) => /has crashed|\(ABORT\)|RuntimeError|unreachable|bad_alloc/.test(String(e?.message ?? e));

/** After wllama crashed, the model is unloaded, and the next translation loads it again. */
function crashed(instance, e) {
  if (instance.crashed) return;
  instance.crashed = true;
  console.error("wllama crashed:", e);
  enqueue(async () => {
    if (loaded === instance) await unload();
    setStatus({ state: "error", model: instance.model.label, message: String(e?.message ?? e) });
  });
}

/**
 * Unloads the model (in the load chain). The translations using it end first, reporting
 * themselves cancelled: wllama's exit() ends its worker without settling the calls it runs.
 */
async function unload() {
  const current = loaded;
  if (!current) return;
  loaded = null;
  for (const j of jobs.values()) if (j.instance === current) j.controller.abort();
  // A call ends at its next result poll, one step of llama.cpp's loop.
  await settled(current, 10_000);
  await current.wllama.exit().catch(() => {});
}

/** Runs `step` after the loads, unloads and measurements asked for before it, one at a time. */
function enqueue(step) {
  const next = loading.then(step);
  loading = next.catch(() => {});
  return next;
}

/**
 * Loads the selected model on the selected device. On `auto` with a GPU, the first load measures
 * the GPU and the CPU and keeps the faster one. Jobs starting together wait for the same load.
 */
const ensureLoaded = () => enqueue(loadSelected);

/** The status while no model is loaded: released, with the model the next translation loads. */
async function setIdleStatus() {
  if (loaded) return;
  const model = await selectedModel();
  setStatus(model && (await isDownloaded(model)) ? { state: "released", model: model.label } : { state: "no_model" });
}

async function loadSelected() {
  const model = await selectedModel();
  if (!model || !(await isDownloaded(model))) {
    setStatus({ state: "no_model" });
    throw Object.assign(new Error("no model is downloaded"), { code: "no_model" });
  }
  let device = settings.device === "cpu" || settings.device === "gpu" ? settings.device : null;
  const gpu = device === "cpu" ? null : await gpuDescription();
  if (device === "gpu" && !gpu) device = "cpu";
  device ??= autoDevice(gpu);
  try {
    if (device) {
      await load(model, device);
    } else {
      await measureDevices(model, gpu);
    }
    setReady(model);
  } catch (e) {
    throw loadFailed(model, e);
  }
}

/** Measures the GPU, then the CPU, with `model`, saves which is faster, and keeps that one loaded. */
async function measureDevices(model, gpu, again = false) {
  setStatus({ state: "measuring", model: model.label, again });
  // Infinity, saved as null.
  const failed = { seconds: Infinity };
  let gpuSpeed = failed;
  try {
    await load(model, "gpu");
    // Without the GPU in use, this would measure the CPU.
    if (loaded.gpu) gpuSpeed = await measure();
  } catch (e) {
    // WebGPU failing (out of memory, for example) leaves the CPU.
    console.warn("WebGPU failed:", e);
  }
  await load(model, "cpu");
  const cpuSpeed = await measure().catch(() => failed);
  const faster = gpuSpeed.seconds < cpuSpeed.seconds ? "gpu" : "cpu";
  localStorage.setItem("measured", JSON.stringify({ hardware: hardwareOf(gpu), device: faster, gpu: gpuSpeed, cpu: cpuSpeed }));
  if (faster === "gpu") await load(model, "gpu");
}

function setReady(model) {
  // `gpuUnavailable`: WebGPU was chosen (or measured) but llama.cpp could not use it.
  setStatus({
    state: "ready",
    model: model.label,
    device: deviceLabel(),
    // The CPU's threads, which the panel shows.
    threads: loaded.gpu ? undefined : loaded.threads,
    gpuUnavailable: loaded.device === "gpu" && !loaded.gpu,
  });
}

function loadFailed(model, e) {
  setStatus({ state: "error", model: model.label, message: String(e?.message ?? e) });
  return Object.assign(new Error(String(e?.message ?? e)), { code: "load_failed" });
}

/**
 * Measures the GPU and the CPU again (the panel's Measure and choose), as job `id`. It ends the
 * running translations, and the background sends no page batches until it is done.
 */
async function remeasure(id) {
  const current = await startJob(id, "measure");
  const next = enqueue(async () => {
    const model = await selectedModel();
    if (!model || !(await isDownloaded(model))) {
      setStatus({ state: "no_model" });
      throw Object.assign(new Error("no model is downloaded"), { code: "no_model" });
    }
    const gpu = await gpuDescription();
    try {
      if (gpu) await measureDevices(model, gpu, true);
      else await load(model, "cpu");
      setReady(model);
    } catch (e) {
      throw loadFailed(model, e);
    }
  });
  try {
    await next;
    post({ type: "done", id, tokens: 0, cut: 0, stopped: false, cancelled: false });
  } catch (e) {
    post({ type: "error", id, code: e.code ?? "failed", message: String(e?.message ?? e) });
  } finally {
    if (jobs.get(id) === current) jobs.delete(id);
    current.finished();
  }
  sendOptions();
}

// ---- Translating ----

/**
 * Starts a job, ending the ones it replaces (they report themselves cancelled): a panel
 * translation (`translate`) or a measurement (`measure`) replaces all the running jobs; a page
 * batch (`segments`) replaces the others and runs beside the other batches. The background sends
 * at most SLOTS. A measurement goes on when replaced; the job after it waits for it.
 */
async function startJob(id, kind) {
  const previous = [...jobs.values()].filter((j) => kind !== "segments" || j.kind !== "segments");
  let finished;
  const running = new Promise((resolve) => (finished = resolve));
  const current = { id, kind, controller: new AbortController(), running, finished };
  jobs.set(id, current);
  for (const j of previous) j.controller.abort();
  // Wait for them to report done, so that messages keep their order.
  await Promise.all(previous.map((j) => j.running));
  return current;
}

/**
 * Generates the translation for `text` (a prompt), streaming pieces to `onText` if given. A job
 * whose model was unloaded meanwhile ends as cancelled (a page batch is then sent again).
 */
async function generate(current, text, maxTokens, onText = null) {
  if (current.instance !== loaded) {
    current.controller.abort();
    throw new DOMException("cancelled", "AbortError");
  }
  const instance = current.instance;
  const options = { prompt: text, max_tokens: maxTokens, temperature: 0, stop: [STOP], abortSignal: current.controller.signal };
  if (!onText) {
    // Not streamed: each poll for a result runs one step of llama.cpp's loop, and a stream polls
    // once per token, so batches streamed side by side would take as many steps as one after
    // another. Unstreamed, their requests wait while each step decodes a token for all of them.
    const result = await complete(instance, options);
    const choice = result.choices?.[0];
    return { output: choice?.text ?? "", tokens: result.timings?.predicted_n ?? 0, cut: choice?.finish_reason === "length" };
  }
  let output = "";
  let tokens = 0;
  let finish = null;
  await complete(instance, {
    ...options,
    stream: true,
    onData: (chunk) => {
      const choice = chunk.choices?.[0];
      tokens++;
      finish = choice?.finish_reason ?? finish;
      if (choice?.text) {
        output += choice.text;
        onText(choice.text);
      }
    },
  });
  return { output, tokens, cut: finish === "length" };
}

/** The output budget for a piece: generous, so that only output running away is cut. */
const maxTokensFor = (source) => Math.min(N_CTX / 2, estimateTokens(source) * 3 + 64);

async function run(id, kind, work) {
  const current = await startJob(id, kind);
  const totals = { tokens: 0, cut: 0 };
  try {
    await ensureLoaded();
    current.instance = loaded;
    if (current.controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
    await work(current, totals);
    post({ type: "done", id, tokens: totals.tokens, cut: totals.cut, stopped: totals.cut > 0, cancelled: false });
  } catch (e) {
    if (current.controller.signal.aborted) {
      post({ type: "done", id, tokens: totals.tokens, cut: totals.cut, stopped: true, cancelled: true });
    } else {
      post({ type: "error", id, code: e.code ?? "failed", message: String(e?.message ?? e) });
    }
  } finally {
    if (jobs.get(id) === current) jobs.delete(id);
    current.finished();
  }
}

function translate(request) {
  return run(request.id, "translate", async (current, totals) => {
    const target = resolveTarget(request.target, request.text);
    post({ type: "started", id: request.id, target });
    const { leading, chunks } = split(request.text, CHUNK_TOKENS);
    if (leading) post({ type: "text", id: request.id, text: leading });
    const history = new History(HISTORY_TOKENS);
    for (const [index, chunk] of chunks.entries()) {
      if (chunks.length > 1) post({ type: "progress", id: request.id, index, count: chunks.length });
      const text = prompt({ text: chunk.text, target, source: request.source, style: request.style, history: history.pairs });
      const result = await generate(current, text, maxTokensFor(chunk.text), (piece) =>
        post({ type: "text", id: request.id, text: piece }),
      );
      totals.tokens += result.tokens;
      if (result.cut) totals.cut++;
      post({ type: "text", id: request.id, text: chunk.separator });
      history.add(chunk.text, result.output.trim());
    }
  });
}

function translateSegments(request) {
  return run(request.id, "segments", async (current, totals) => {
    const target = resolveTarget(request.target, request.segments.join("\n"));
    post({ type: "started", id: request.id, target });
    const history = new History(HISTORY_TOKENS);
    const piece = async (text) => {
      const result = await generate(current, prompt({ text, target, source: request.source, style: request.style, history: history.pairs }), maxTokensFor(text));
      totals.tokens += result.tokens;
      if (result.cut) totals.cut++;
      const translation = result.output.trim();
      history.add(text, translation);
      return { translation, tokens: result.tokens };
    };
    for (const [index, segment] of request.segments.entries()) {
      let translation = "";
      let tokens = 0;
      if (estimateTokens(segment) <= CHUNK_TOKENS) {
        ({ translation, tokens } = await piece(segment));
      } else {
        // A long run (a paragraph with line breaks, an article in one element) goes in chunks,
        // as in the app, so that each fits a slot's context.
        const { leading, chunks } = split(segment, CHUNK_TOKENS);
        translation = leading;
        for (const chunk of chunks) {
          const result = await piece(chunk.text);
          translation += result.translation + chunk.separator;
          tokens += result.tokens;
        }
        translation = translation.trim();
      }
      // The tokens let the background tell the page's speed over its batches running together.
      post({ type: "segment", id: request.id, index, text: translation, tokens });
    }
  });
}

// ---- Status and options ----

function setStatus(next) {
  status = next;
  sendStatus();
}

function sendStatus() {
  // `slots`: the page batches to send at once.
  post({ type: "status", engine: "browser", slots: SLOTS, ...status });
}

async function sendOptions() {
  const gpu = await gpuDescription();
  const models = [];
  for (const model of MODELS) {
    const state = await localState(model);
    models.push({
      id: model.id,
      label: model.label,
      bytes: model.bytes,
      downloaded: state !== null,
      downloading: downloads.has(model.id),
      // A newer version than the file there: its day and what it changed.
      ...(state === "outdated" ? { newer: { date: model.published.slice(0, 10), change: model.change } } : {}),
    });
  }
  post({
    type: "options",
    engine: "browser",
    models,
    devices: [
      { name: "cpu", description: `WebAssembly, ${navigator.hardwareConcurrency} threads`, kind: "cpu" },
      ...(gpu ? [{ name: "gpu", description: gpu, kind: "gpu" }] : []),
    ],
    model: settings.model || null,
    device: settings.device || null,
    // The thread counts to choose from go up to the logical cores.
    cores: navigator.hardwareConcurrency,
    threads: settings.threads || null,
    // What `auto` uses (null until measured), and the last measurement.
    auto: autoDevice(gpu),
    measured: gpu ? savedMeasurement(hardwareOf(gpu)) : null,
  });
}

// ---- Messages ----

port.onMessage.addListener(async (message) => {
  switch (message.type) {
    case "configure":
      settings = { model: message.model ?? "", device: message.device ?? "auto", threads: Number(message.threads) || 0 };
      sendStatus();
      // The next translation loads what is chosen now. The unload waits for a load or measurement
      // in progress, and ends the translations that use the model.
      enqueue(async () => {
        if (
          loaded &&
          (loaded.model.id !== (await selectedModel())?.id ||
            (settings.device !== "auto" && settings.device !== loaded.device) ||
            (!loaded.gpu && settings.threads !== loaded.requestedThreads))
        ) {
          await unload();
        }
        await setIdleStatus();
      });
      return;
    case "status":
      sendStatus();
      return;
    case "options":
      sendOptions();
      return;
    case "download": {
      const model = MODELS.find((m) => m.id === message.model);
      if (model) download(model);
      return;
    }
    case "delete": {
      const model = MODELS.find((m) => m.id === message.model);
      if (model) deleteModel(model);
      return;
    }
    case "cancel":
      // One job, or without an id all of them.
      for (const j of jobs.values()) if (message.id == null || j.id === message.id) j.controller.abort();
      return;
    case "translate":
      translate(message);
      return;
    case "translate_segments":
      translateSegments(message);
      return;
    case "measure":
      remeasure(message.id);
      return;
  }
});

// Chrome stops an idle service worker, which would drop this port; it is kept alive by messages.
// The background closes this document after a while without work.
setInterval(() => post({ type: "keepalive" }), 20_000);
// Without the background (its service worker stopped anyway), nothing would release the model.
port.onDisconnect.addListener(() => {
  unload().finally(() => window.close());
});

// Ask for the persistent storage that keeps the models when space runs short.
navigator.storage.persist?.().catch(() => {});
enqueue(setIdleStatus);
// Nothing downloads before this document asks, so what a closed one left can go.
modelsDir()
  .then(async (dir) => {
    for (const model of MODELS) await removeStaleParts(dir, model, partName(model));
  })
  .catch(() => {});
refreshCatalog();
