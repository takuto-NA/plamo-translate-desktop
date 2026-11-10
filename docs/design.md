# PLaMo Translate Desktop — Design

Status: describes the code of v0.5.0 (released 2026-11-10). Update it together with the code.

## 1. Goal

A desktop translation app that runs [PLaMo 3 Translate](https://www.preferred.jp/ja/blog/tech/plamo-3-translate-weight-release)
entirely on the local machine. It is written in Rust with GPUI.

- Primary platform: Windows (x86_64, MSVC). Secondary: Linux (x86_64).
- Typical use: paste text, get the translation as you type, copy it out.
- The user picks the model (size and quantization) and the inference backend (CPU or a GPU) in the GUI.
  Models are downloaded on demand with visible progress.

Non-goals for now:

- Remote inference servers (OpenAI-compatible llama-server or vLLM). The backend trait leaves room for one,
  but it will not be built until it is needed.
- macOS, mobile, and the non-GGUF weight formats (BF16, FP8, W4A16, NVFP4, MLX). Those formats target
  vLLM, Transformers, or Apple silicon.

## 2. Model facts this design relies on

Source: the Hugging Face model cards `pfnet/plamo-3-translate-{0.8b,2b,8b,31b}` and their `-GGUF` variants.

- Architecture `Plamo3ForCausalLM`. Sliding-window attention (window 2048) with full attention on every
  8th layer, YaRN RoPE for full layers, and plain RoPE for local layers. llama.cpp supports it (`src/models/plamo3.cpp`).
- Maximum length during training: 32,768 tokens for input and output combined.
- GGUF files (`pfnet/plamo-3-translate-<size>-GGUF/plamo-3-translate-<size>-<quant>.gguf`):

  | Size | Q4_K_M | Q4_0 | Q3_K_M | Q2_K |
  |------|--------|------|--------|------|
  | 0.8B | 0.57 GB | 0.55 GB | 0.49 GB | 0.41 GB |
  | 2B   | 1.81 GB | 1.70 GB | 1.50 GB | 1.23 GB |
  | 8B   | 5.28 GB | —       | 4.31 GB | 3.45 GB |
  | 31B  | 19.53 GB | —      | 15.86 GB | 12.61 GB |

  Q4_K_M is the recommended default.
- Prompt format: PFML3 (see §5). Decoding is greedy. Generation stops at `<|plamo:tag|>` or `<|plamo:bos|>`.
- 53 target languages, identified by lowercase codes (`ja`, `en`, `zh-hans`, `zh-hant`, …). The official chat
  template also accepts `ja(easy)` (easy Japanese), which the model card does not document.
  We treat it as experimental.
- License: PLaMo Community License. Personal and non-commercial use is free. Commercial use is free up to
  ¥1B annual revenue, with prior registration. The app shows the license before the first download and records the user's acceptance.

## 3. Technology choices

| Concern | Choice | Notes |
|---|---|---|
| UI | GPUI via `gpui-kit` 0.9 | Ships a pinned Zed snapshot (`gpui-pre` 0.3.11) and components such as textarea, select, progress, notification, settings, and resizable panes. The crates.io `gpui` 0.2.2 has not been updated since 2025-10. |
| Inference | llama.cpp in-process via `llama-cpp-2` | The only engine that runs PLaMo 3 today and covers CPU, Vulkan, ROCm, and CUDA on Windows and Linux. Pinned to a llama-cpp-rs git revision for now: crates.io 0.1.161 vendors llama.cpp 0.6.0, which lacks the `plamo3` tokenizer. |
| GPU selection | `llama-cpp-2` feature `dynamic-backends` | ggml backends are separate DLL/.so modules loaded at runtime, so one build serves CPU and Vulkan users. |
| HTTP (downloads) | `ureq` on dedicated threads | Avoids running tokio alongside the GPUI executor. |
| Settings / paths | `serde_json`, `directories` | |
| i18n | `rust-i18n` (already used by gpui-kit), `sys-locale` | English and Japanese. The OS locale picks the default. |

Rust-native engines were considered and rejected for now. Candle and mistral.rs have no PLaMo 3
implementation and support only CUDA and Metal GPUs, so the target AMD GPU would fall back to CPU.
burn and cubecl reach Vulkan and ROCm, but we would have to write the model and the GGUF quantized kernels ourselves.
The backend trait (§6) keeps the door open.

## 4. Architecture

### 4.1 Workspace layout

```
crates/
  pfml/     PFML3 prompt builder, language table, validation. Pure Rust, no I/O.
  engine/   Backend trait, llama.cpp backend, model catalog and discovery, downloader,
            long-text splitting and loop detection. No GUI dependency.
            examples/translate.rs and examples/download.rs are headless CLIs for testing.
  appdata/  Settings, file locations, logging, device selection: shared by app and host.
  update/   Newer releases on GitHub: the check, its once-a-day cache, version order.
  desktop/  Outside the window: double copy, the one running instance, and the
            notification-area icon on Windows (§9.1).
  app/      GPUI application (binary `plamo-translate-desktop`).
  host/     Native messaging host for the browser extension (binary `plamo-translate-host`).
extension/  Browser extension (Manifest V3) for Chrome and Edge; vendor/wllama is the
            in-browser engine's WebAssembly build.
assets/     Icon (scripts/gen_icons.py) and the Linux desktop entry.
licenses/   License texts appended to THIRD-PARTY-NOTICES.txt (scripts/notices.sh).
patches/    Patches applied to wllama before its build (.github/workflows/wllama.yml).
scripts/    Icon and notices generators, the changelog's release notes, wllama's vendoring,
            the macOS package, and the ROCm build environment.
tests/      The extension's tests (Node).
docs/       This document.
```

### 4.2 Threads

```
GPUI main thread ──Command──▶ inference worker (one std::thread, owns runtime/model/context)
      ▲  ◀──Event──────────────┘
      └──◀── download threads ─── Progress | Finished | Failed
```

- The inference worker (`engine::worker`) owns all llama.cpp state, so llama.cpp objects never cross threads.
  Commands are `Load`, `Unload`, and `Translate { job, options, document, text }`.
- Events: `RuntimeFailed`, `Devices`, `LoadProgress`, `Loaded`, `LoadFailed`, `Unloaded`,
  and per job `Chunk`, `Token`, `Rewind`, `Retry`, `Cut`, `Finished`, `Failed`.
  A panic of the worker thread is reported as `RuntimeFailed`.
- Jobs supersede each other: a shared `AtomicU64` holds the newest job id, so submitting a translation
  cancels the running one (checked before every generated token) and stale queued jobs are skipped.
  This is what auto-translate needs.
- Each load ends in exactly one `Loaded` or `LoadFailed`. Load events carry no id, so the app counts outstanding loads
  and acts only on the last one.
- The UI receives events through `async-channel` and applies them in batches of one 50 ms frame,
  so a fast GPU does not stall the UI thread.
- Download threads throttle progress events to about 10 Hz.
- The clipboard watcher and the instance listener (§9.1) run on threads of their own and send to the UI
  through an `async-channel` (`shell::Message`).

## 5. Prompt construction (crate `pfml`)

PFML3 elements are delimited by special tokens:
`<|plamo:tag|>` starts an element, `<|plamo:key|>`/`<|plamo:val|>` add attributes, and `<|plamo:msg|>` starts the body.
The glossary uses `<|plamo:index|>` (source term) and `<|plamo:item|>` (target term). The order mirrors the
official `chat_template.jinja`:

```
<bos>
<|plamo:tag|>dataset<|plamo:msg|>translation
[<|plamo:tag|>context<|plamo:msg|>{context}]
[for each history pair:
   <|plamo:tag|>input[<|plamo:key|>lang<|plamo:val|>{src}]<|plamo:msg|>{source}
   <|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{tgt}<|plamo:msg|>{translation}]
[<|plamo:tag|>glossary(<|plamo:index|>{term}<|plamo:item|>{translation})*]
<|plamo:tag|>input[<|plamo:key|>lang<|plamo:val|>{src}]<|plamo:msg|>{text}
<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{tgt}[<|plamo:key|>form<|plamo:val|>{plain|polite}]<|plamo:msg|>
```

- `source_lang` is optional. When it is omitted, the model detects the language.
- `form` is allowed only when the target is `ja`.
- The builder returns a list of segments, `Special(&'static str)` or `Text(String)`, not one string.
  The llama.cpp backend tokenizes special segments with `parse_special = true` and user text with `parse_special = false`.
  Text that contains `<|plamo:…|>` therefore can never inject control tokens.
  Because llama.cpp splits on special tokens before running BPE, per-segment tokenization gives the same
  tokens as tokenizing the whole prompt.
- A string renderer (for debugging and any future HTTP backend) rejects text that contains `<|plamo:`,
  as the official template does.
- Validation mirrors the template: language codes, non-empty text, and glossary entries.

## 6. Inference engine (crate `engine`)

```rust
pub trait TranslationBackend {
    fn translate(
        &mut self,
        prompt: &pfml::Prompt<'_>,
        generation: &Generation, // output length limit, DRY on or off
        sink: &mut dyn FnMut(&str),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<TranslateStats>;
}
```

The implementation is `engine::llama::Session` (one llama.cpp context of a loaded `Model`):

- At startup `Runtime::init` loads the ggml backend modules next to the executable (`load_backends_from_path`),
  then lists devices with `list_llama_ggml_backend_devices()`.
- Model parameters: the selected device(s) (`with_devices`) and the number of GPU layers (all by default).
  - A fully offloaded model is read instead of memory-mapped. A mapping keeps the whole file in the process's memory
    as long as the model is loaded, although the weights are in VRAM.
    Measured with ROCm while translating: 0.8B uses 335 MiB instead of 964 MiB, and 2B 374 MiB instead of 2,142 MiB
    (214 MiB of either is the ROCm libraries). Loading takes the same 1–2 s.
  - On the CPU (or with partial offload) the file stays memory-mapped: those pages are the weights in use.
  - On macOS it stays memory-mapped too: with unified memory, Metal uses the mapped pages themselves.
    Measured on an M3 with 0.8B: a peak memory footprint of 205 MB instead of 763 MB, at the same speed.
- Context: `n_ctx` is fixed at 32768 (see §8).
- Decoding is greedy. It stops on the `<|plamo:tag|>` token, on any end-of-generation token (`<|plamo:bos|>` is the EOS),
  on cancellation, when the context is full, or when the output runs away (6.1).
- Output is decoded incrementally, so a UTF-8 sequence split across tokens is never shown half-finished.
- Each request starts with a fresh KV cache. Reusing the KV prefix across chunks is a later optimization.

### 6.1 Long text

`engine::document` handles long texts. The worker runs every request through it, and a short text is a single chunk.

- Splitting:
  - The text is split into paragraphs at blank lines.
  - Neighbouring paragraphs are packed into one chunk while they fit.
  - A paragraph larger than the chunk budget is split at the most natural boundary that makes it fit, in this order:
    1. Line breaks after the end of a sentence. Japanese prose usually separates paragraphs with a single newline (and indents with U+3000).
    2. Sentence ends (`。！？．`, or `.!?` before whitespace), keeping closing quotes and brackets with their sentence.
       Other line breaks are ordinary whitespace here, so hard-wrapped prose keeps its sentences whole.
    3. Any line break, for a sentence that is still too long.
    4. After clause punctuation (`、，,;；:：`) or at whitespace.
    5. By character count, the last resort for text without any of the above (minified data, for example),
       so that no chunk exceeds the budget.
  - Pieces are packed on summed token counts; the packed text is measured exactly only near the limit.
  - Leading whitespace and the separators between chunks are copied unchanged into the output.
- Budget: a chunk gets at most 1,024 tokens and history at most 4,096 (`DocumentOptions`).
  Settings → Chunk size and History change these (256–4,096 and none–8,192 tokens; other values can be set in `settings.json`).
  They are part of the translation cache key.
  They are further limited to 1/6 and 1/3 of `n_ctx` minus the fixed parts (context and glossary, plus a margin of 64 tokens),
  which leaves the output room for about three times the chunk.
- Why chunks are small, although the model was trained on 32k tokens:
  - PLaMo 3 attends to only the last 2,048 tokens in 7 of every 8 layers. Small models decoding greedily lose their place in long outputs.
  - Measured with 0.8B Q4_K_M on the first 250 KB of an English book (Project Gutenberg #5000, into Japanese, ROCm):

    | Chunk / history (tokens) | Chunks | Looped | Output paragraphs (source: 1,158) | Time |
    |---|---|---|---|---|
    | about 5,400 / 10,900 (the earlier 1/5 and 1/2 of 32k) | 11 | 5 | 607 | 533 s |
    | 1,024 / 4,096 | 57 | 0 | 1,159 | 202 s |

    Large chunks also dropped about half of the paragraphs silently.
  - PFN's published scores are for sentence- and paragraph-level inputs, and the model card's examples cap the output at 512 tokens.
  - A typical paragraph still fits in one chunk: in that book, 4 of 6,942 paragraphs exceed about 700 words.
- History: chunks are translated in order. The most recent source/translation pairs that fit the history budget go into each prompt,
  and the oldest drop first, as the model card recommends.
- Runaway output (`engine::repetition`):
  - Greedy decoding can fall into a cycle and repeat a few tokens until the context is full.
    Whether it does depends on near-ties between tokens, so it differs between backends, GPUs, and thread counts.
  - The detector tracks, for each period up to 128 tokens, how long the output has repeated with that period (constant time per token and period).
    A loop is a span of at least 64 tokens that repeats its cycle at least three times.
    The threshold rises to twice the longest such span in the prompt, so input that repeats legitimately (rulers, refrains) can be translated.
  - The output of a chunk is also limited to 3 × its tokens + 128.
  - A chunk of at least 200 tokens whose translation ends at under a quarter of its tokens counts as incomplete:
    large chunks often ended early and silently skipped the rest. It is retried like a loop.
  - Recovery:
    1. A chunk whose output runs away (or is incomplete) is withdrawn (`Output::Truncate`, `Event::Rewind`) and translated again in pieces of up to 256 tokens,
       split at the same boundaries as chunks.
    2. A piece that runs away again is translated sentence by sentence.
       (Retrying a chunk sentence by sentence straight away needed dozens of prompts, each with the whole history: minutes on the CPU.)
    3. A sentence that runs away again is retried with llama.cpp's DRY sampler (multiplier 0.8, base 1.75, allowed length 2), which penalizes the output repeating itself.
       DRY is not used otherwise, because it also discourages legitimate repetition.
       A level that would not split the text further is skipped: the same input with the same history only repeats the same output.
    4. If even that loops, the output is cut after the cycle's first occurrence.
       When the prompt contains the same cycle (text copied verbatim, such as repeated lines of code), as many repeats as the prompt has are kept:
       the model tends to copy such text and not stop, and only the repeats beyond the source's are the loop.
  - Output that ran away never enters the history, so one loop cannot seed the next.
  - A cut is marked in the translation (`DocumentOptions::cut_marker`, in the UI language), so it shows when the text is copied.
    The engine emits the marker itself, keeping the output offsets it reports in step with the text.
  - The app logs retries and cuts to `app.log` (without text, with the source character position of a cut).
    The status bar reports cuts; clicking it selects the next cut passage in both panes.
- The worker reports `Chunk { index, count, source }`. The status bar shows the chunk (`(2/5)`), the tokens generated,
  the speed, and the remaining time. The estimate counts progress in source bytes, with the chunk in progress weighted by its output
  against the output per source byte of the finished chunks; it appears once a chunk is done.

### 6.2 Context and glossary

- The toolbar button "Context & glossary" opens two text areas below the panes.
- Context is free text for the whole request. It is not persisted, because it is usually per document.
- The glossary is written one term per line as `source = target`. A tab, `=>`, or `→` also works, and `#` starts a comment.
  It is saved in settings, and the button shows the number of terms.
- Editing either text area re-translates after the usual debounce.

## 7. Model management

- The catalog (`engine::models`) starts with a built-in list (`BUILTIN`) of the 14 GGUF files published at build time.
  Each entry has its repo, pinned commit, file name, size, and SHA-256, and the download URL uses the pinned commit.
  - Hugging Face has no version numbers, so an entry's version is the commit that last changed the file: its date (`published`)
    and title (`change`).
- Catalog discovery (`engine::discovery`) keeps the app current without a new release:
  - At start-up it searches Hugging Face for `pfnet/<family>-<size>-GGUF` repositories of supported families (today `plamo-3-translate`).
  - It pins each repository to its current commit and reads each `<family>-<size>-<quant>.gguf` with its size and SHA-256 from the Git LFS metadata.
    The tree is listed with `expand=true`, which adds the commit that last changed each file.
  - New sizes or quantizations are added, and newer revisions of known files replace the old ones. An entry only replaces one with an
    earlier date. Entries cached by versions before 0.5.0 have no date and may be older than the built-in list, so they never replace a dated one.
  - The result is cached in `catalog.json` next to the models, so offline starts know it. "Check again" in the dialog repeats the search.
- PFN replaces the files now and then: four times between 2026-11-04 and 2026-11-08, each time changing only the chat template,
  which the app does not use (it writes its own prompts).
  - A downloaded file is used whatever its revision (`LocalState::Outdated` when its size is not the newest one's), so a new revision
    never makes a model look missing. Its row says a newer version is out, with the date, and Update downloads it; the Update button's
    tooltip has the commit title, which says what changed.
  - The newer file downloads beside the older one, which stays usable meanwhile. When it is verified, the older file is replaced:
    for the active model, after the worker has released it (Windows cannot replace a loaded file), and the model is then loaded again.
    If the browser host still holds the file on Windows, the row shows the error and Update retries (the finished part is only hashed again).
  - A new model generation with a different prompt format still needs an app update, so unknown families are ignored.
- Quality data (`engine::models::QUALITY`) holds the scores PFN publishes for every file and for the BF16 reference:
  PFTB, SaaS, WMT24++ COMET-22, and FLORES+ chrF++ (Ja↔ and En↔14 languages).
  - The dialog groups files by size. Each size has a header with a description and its BF16 scores.
  - Each file shows Ja↔En (PFTB) and multilingual (FLORES+ Ja↔) scores with the difference from BF16.
    Drops beyond 0.003 / 0.3 are amber, and beyond 0.008 / 0.8 red.
  - Files without published figures (discovered later) say so.
- Cached entries are dropped unless they look like what discovery produces (repository and file name patterns, hex digests),
  because the file name becomes a path that is written and deleted.
- Download (`engine::download`): `GET https://huggingface.co/<repo>/resolve/<revision>/<file>` into `<file>.<digest>.part`
  (named after the expected SHA-256, so a partial file of an older revision is never resumed). It uses `ureq` on its own thread,
  with a 30 s read timeout so a stalled connection cannot block cancellation.
  - Hugging Face redirects to a CDN that honours `Range`, so an interrupted or cancelled download resumes from the partial file.
  - The existing part is hashed first, so the digest always covers the whole file.
  - The file is renamed into place only after the SHA-256 matches, so a final file counts as downloaded. A file of an older revision with
    that name is left for the app to replace (`Downloaded::BesideOlder`, then `ModelStore::replace_with_download`).
  - Progress reports bytes and two rates, throttled to 10 Hz.
    The recent rate (exponentially smoothed) is what the UI shows.
    The average since the transfer started is used for the ETA once 3 s have passed, so the estimate does not jump around.
- Storage:
  - Windows: `%LOCALAPPDATA%\plamo-translate-desktop\data\models`
  - Linux: `$XDG_DATA_HOME/plamo-translate-desktop/models` (usually `~/.local/share/...`)
  - Both come from `directories::ProjectDirs::data_local_dir()`, the data directory, which also holds the caches and logs.
  - **Change…** next to the folder in the Models dialog picks another one (`models_dir` in the settings; **Use the default** clears it).
    Nothing is moved. The model loaded from the old folder gives way to what the new one has, chosen as at start, and the host
    reads the folder from the settings too. It is disabled while a download runs, which would finish in the old folder.
    On Linux the folder picker is the desktop portal's; without one, the dialog says so and points to `settings.json`.
  - A GGUF path given on the command line or in `PLAMO_MODEL` overrides the selection (for development).
- The Models dialog opens from the model button in the status bar. Each row shows its state and actions:
  - Not downloaded: Download.
  - Downloading: a progress bar and Cancel.
  - Paused: Resume and Delete.
  - Downloaded: Use (Unload for the active model) and Delete.
  - Downloaded, a newer version out: the date of the newer one, and Update besides Use and Delete.
  - Deleting asks for confirmation.
  - Deleting the active model unloads it first. The file is removed after the worker reports `Unloaded`, because Windows cannot delete a memory-mapped file.
  - Downloads stay disabled until the user accepts the PLaMo Community License. The acceptance is saved in settings.
    The license is shown as a modal at first start, with "I agree" and "Later".
    Until it is accepted, the Models dialog shows a one-line notice with "Review license".
    Afterwards it shows only "Built with PLaMo · PLaMo Community License".
- Startup picks the first available of: the saved selection if downloaded, 2B Q4_K_M if downloaded, any downloaded model.
  With no model, the Models dialog opens and the first finished download becomes active automatically.
- The model marked "Recommended" comes from `engine::models::recommend`: the largest Q4_K_M up to 8B whose file is
  at most 2/3 of the free memory of the selected device (system memory for the CPU).

## 8. Backend selection

- After llama.cpp starts, the worker reports the device list from ggml, for example:
  - `CPU`
  - `Vulkan0 — AMD Radeon RX 9070 XT (16 GB)`
  - `Vulkan1 — AMD Radeon(TM) Graphics`
- The first model load waits for this list.
- The device setting is saved as one of three values:
  - `auto` (the default) picks the fastest device measured on this machine (`measured` in the settings), as long as the devices
    (CPU, discrete and integrated GPUs, by name and description) are the ones measured. Without a measurement it picks
    the discrete GPU with the most free memory, or the CPU if there is none. NPUs are never picked automatically.
  - Integrated GPUs range from much slower than the CPU (Ryzen 9 9950X's 2-CU Radeon: 6.6 against 17.4 tok/s for 2B) to much faster
    (Core Ultra 7 356H: 70 against 40; Ryzen AI Max+ 395's Radeon 8060S). So with an integrated GPU and no discrete one,
    the first load on `auto` measures first: the worker loads the model on the CPU and on each GPU in turn
    (`Worker::measure`), translates a fixed paragraph (twice on a GPU, the first run compiling its kernels), and reports the speeds.
    The device that would translate a typical piece (200 prompt and 100 generated tokens) fastest is saved, and the model loads.
    The status bar says that this happens on the first start only.
  - **Measure and choose** in Settings measures all candidates with the active model at any time and sets the device to `auto`.
    The last results are shown under the device while they hold. `translate --measure` prints the same measurement.
  - The browser host does not measure; it uses the app's measurement.
  - `cpu`.
  - A device name such as `Vulkan0`. If that device disappears, the app falls back to `auto`.
- The model is fully offloaded to the selected GPU. Partial offload (GPU layers) is a possible later setting.
- On the CPU the model gets an empty device list: by default llama.cpp also hands large operations to every GPU-type device (op offload),
  which would use a GPU the user chose not to use (or OpenVINO's placeholder device, which fails).
- The context length is fixed at 32768, the maximum the model was trained with, and is not a setting.
  - The KV cache for sliding-window layers is limited to the window (`swa_full = false`). This is safe because every request starts from an empty cache.
  - At 32k this needs 0.05 / 0.3 / 0.4 / 1.6 GiB of KV cache for 0.8B / 2B / 8B / 31B. With a full SWA cache it would be 0.26 / 1.5 / 2.0 / 8.2 GiB.
  - Translation speed does not depend on the context length (measured: 144–148 tok/s for 2B at 4k, 16k, and 32k).
- CPU threads are set automatically. Prompt processing uses the physical cores, and generation uses at most 8,
  because it is memory-bound.
- Memory check: the app estimates the file size × 1.2 + 384 MiB.
  If that exceeds the free memory of the selected device, the dialog shows a warning; the model still loads.
- Changing the device reloads the model. The status bar shows the model and the device, for example `2B · Q4_K_M · Vulkan0`.
- Intel NPUs (the Windows `-intel-npu` package; experimental) run through llama.cpp's OpenVINO backend (`ggml-openvino`):
  - The backend registers every OpenVINO device (`OPENVINO0`…) but computes only on the one chosen by `GGML_OPENVINO_DEVICE`
    when it loads, and aborts if that one is missing. So the variable is left unset and the package ships OpenVINO's NPU plugin only:
    the NPU is then the only OpenVINO device and is chosen. Without an NPU the backend registers a placeholder `CPU`.
  - `Runtime::devices` lists only the OpenVINO device computed on, and only if it is an NPU, as `DeviceKind::Npu` named `NPU`
    (from the description `GGML_OPENVINO_DEVICE=NPU (selected) - <name>`). `auto` never picks it.
  - On an NPU the graphs have fixed shapes (prompts in 256-token chunks, every mask as wide as the context), so the session
    uses an 8192-token context (`SessionOptions::for_npu`) and long texts get smaller chunks and history.
    The sliding-window cache is full length there (`swa_full`): with a windowed cache the backend's mask for those layers
    does not match their cache and the graph fails to compile.
  - The first translation compiles the model for the NPU. When the module ships next to the executable, `GGML_OPENVINO_CACHE_DIR`
    is set at start-up to `openvino-cache` in the data directory, so the compiled graphs are reused (the variable is read once, when the backend loads).
  - Checked without an NPU on OpenVINO's CPU device with `GGML_OPENVINO_FORCE_STATIC=1` (the NPU's fixed-shape path):
    the same translations as the CPU backend, apart from rare one-word differences.
  - Measured on a Core Ultra 7 356H (Panther Lake, 50 TOPS NPU) with 2B Q4_K_M: about 30 tok/s on the NPU, 40 on the CPU,
    and 70 on the integrated GPU through Vulkan. Generation is memory-bound, the NPU reads memory more slowly than the GPU,
    and its fixed shapes add the whole context's attention to every token. The NPU is for lower power and a free GPU.
  - The package must ship OpenVINO's NPU compiler (`openvino_intel_npu_compiler.dll`, 100 MB): without it the NPU does not work,
    so the compiler in the NPU driver is not enough.

## 9. UI

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ PLaMo Translate                                                     _  □  × │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Detect ▾]  ⇄  [Japanese ⇄ English ▾]  [Style ▾]   Context & glossary  (o) Auto [Translate] │
├───────────────────────────────────────┬──────────────────────────────────────┤
│ Source                                │ Translation (streaming)              │
│ 1,234 chars                  [Clear]  │                              [Copy]  │
├───────────────────────────────────────┴──────────────────────────────────────┤
│ Translating… (3/12) · 4,210 tokens · 250.3 tok/s · about 2 min left   [2B · Q4_K_M · Vulkan1] ⚙ Built with PLaMo │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Auto-translate is on by default; the Auto switch in the toolbar turns it off.
  - A paste translates immediately. Typing is debounced by 500 ms. With Auto off, only Translate (or `Ctrl+Enter`) translates.
  - Editing the input cancels the running job and starts a new one.
  - Results are cached by (input, settings), so swapping languages back and forth costs nothing.
- The source pane has focus at startup. `Ctrl+Shift+C` copies the translation, and `Ctrl+Enter` translates immediately.
- Languages:
  - The default source is "Detect language".
  - The default target is "Japanese ⇄ English (auto)": text with kana goes to English, and everything else goes to Japanese.
    Kanji alone does not count, because it may be Chinese.
  - Swapping exchanges explicit languages and moves the translation into the source pane.
- The title bar is drawn by the app (gpui-kit `TitleBar`) on every platform.
  Wayland compositors such as WSLg and GNOME do not draw server-side decorations.
  - The title bar holds only the title. On Linux, a press on the title bar arms a window move, and any pointer motion before release
    hands the pointer to the compositor, so buttons there can lose clicks.
  - The Models button (model and device, or "Choose a model…" in primary style when none is loaded) and the Settings gear sit at the right end of the status bar.
- Translation options:
  - Style (plain or polite) is shown only for a Japanese target.
  - Context is a separate textarea.
  - The glossary is a text area (see §6.2).
- The Models & Backend dialog lists the catalog with status and Download, Cancel, Use, and Delete actions,
  a progress bar showing rate and ETA, and the backend and device settings.
- While a translation runs, the Translate button becomes Stop. Stopping keeps the partial output; it is marked partial,
  so it is never cached and the same request translates again.
- Streamed text is applied as edits at the end of the output pane. Replacing the whole value every frame laid out the entire translation
  again and stalled the UI on long texts.
- The status bar ends a translation with the time taken, the tokens, and the speed. When passages were cut, clicking the message selects the next one in both panes.
- Settings (the gear): display language, theme, UI size, chunk size, history, synchronized scrolling, and the browser extension
  (Connect and Disconnect the host, Open extension folder; see §12).
- Streaming keeps the output pane's scroll position, so a reader can scroll through a long translation while it grows.
  A new translation starts at the top.
- Japanese IME input goes through gpui-kit's textarea.
- Synchronized scrolling (Settings, on by default; `crates/app/src/align.rs`):
  - Chunk starts are known pairs of source and output positions. Within a chunk, paragraphs (blank-line separated, or lines in text without blank lines)
    are paired when both sides have the same number; otherwise the chunk is one segment. Positions inside a segment map proportionally.
    The chunk still being translated pairs the paragraphs translated so far, in order; its untranslated paragraphs have no counterpart.
  - Scrolling a pane scrolls the other so the counterpart of its first visible line is at the top.
    Moving the caret selects the counterpart paragraph in the other pane, level with the caret; each pane keeps its selection visible while the other has focus.
  - A pane that was scrolled to follow ignores its own changes for 150 ms, so the two do not chase each other.
  - It applies while the source is the text that was translated; cached results keep their chunks for it.
- Theme: Settings → Theme (System, Light, or Dark). System follows the OS, including changes while the app runs.
  The light and dark themes come from gpui-kit.
- UI size: Settings → UI size (100–200%, on top of the OS's display scaling). GPUI takes the scale from the OS: per display on Windows,
  macOS and Wayland, and on X11 once at start for every display (`GPUI_X11_SCALE_FACTOR`, else `Xft.dpi`, else the primary display's
  physical size). Some desktops give none on a high-DPI display, hence the setting.
  - It sets the theme's font size (16 px at 100%), which is also the rem size. gpui-kit's components are sized in rems, and the app's
    own fixed lengths go through `view::scaled` (rems) or `view::scaled_px` (pixels, for dialog widths), so the whole interface follows.
  - The window opens at the default size times the UI size, within 90% of the primary display.
- UI strings live in `crates/app/locales/app.yml`. The language is the first that applies of:
  1. `PLAMO_LANG` (a development override).
  2. Settings → Display language (System, English, or 日本語).
  3. The OS locale.
- The change applies immediately. Components that baked strings in when they were created (select items, placeholders) are rebuilt,
  and everything else is translated at render time.

### 9.1 Outside the window

`crates/desktop` holds the platform code, and `crates/app/src/shell.rs` what the app does with it, outside any window.

- One instance per user (`desktop::instance`). The first holds a lock file, `plamo-translate-desktop.lock` in `$XDG_RUNTIME_DIR` on Linux
  and in the temporary directory on Windows and macOS (per user there). The system releases it when the process ends, also after a crash.
  - A second start finds the lock taken, asks the running instance to show its window, and exits. On Windows the request goes to
    a hidden window found by its class, after `AllowSetForegroundWindow` so that the running one may take the foreground;
    elsewhere it goes through a Unix socket next to the lock.
  - The update helper starts the new version only after the old one has exited (§11), so the two never meet.
  - If the check fails, the app runs on its own, as before.
- Staying resident (Settings, off by default). GPUI runs with `QuitMode::Explicit`, and the shell quits when the last window closes unless the app stays resident.
  - The window's view owns the worker, so closing the window releases the model. The next window is a new `TranslatorView`,
    with the settings read from disk, and loads the model again.
  - Windows: the notification-area icon opens the window (click, or Open in its menu) and quits the app (Quit). The instance's hidden window owns it
    and adds it again when Explorer restarts (`TaskbarCreated`).
  - macOS: the Dock opens the window (`on_reopen`).
  - Linux: starting the app again opens the window. A tray icon (StatusNotifierItem) needs a host, which GNOME has only with an extension, and WSLg not at all.
  - `Ctrl+Q` (`Cmd+Q`) quits on every system.
- Double copy (Settings, off by default; `desktop::clipboard`, issue #7): the clipboard changing twice within 500 ms. Changes within 60 ms of the previous one
  count as one copy, since some applications write the clipboard more than once per copy.
  - Only the clipboard is watched, never the keyboard: no permission, no key hook, and Ctrl+C works as before.
    A second Ctrl+C with nothing selected leaves the clipboard as it was, so an old clipboard is not translated.
  - The shell then shows the window and translates the text, also with Auto off. A double copy while the app's own window is active
    (the copy button clicked twice) is ignored.
  - Windows: `AddClipboardFormatListener`, on a message-only window of the watcher's thread. The text is read at the second copy only,
    which spares the copying application from rendering text for every copy.
  - macOS: `NSPasteboard.changeCount`, polled every 40 ms. The text is read at the second copy only. Apple has announced an alert for apps that read
    the pasteboard without a paste by the user (not on by default yet); reading only at a double copy keeps such an alert to that moment.
  - Linux: the X server's selection-owner events (XFixes); in a Wayland session, Xwayland's, which follows the Wayland clipboard.
    A bridged clipboard changes more than once per copy, first without text: WSLg announces a copy made in Windows before its text arrives, 100–300 ms later.
    So the text is read at every change; a change without text does not count, and the two copies must hold the same text.
    Without `DISPLAY` the setting says it is unavailable. Text too large for one transfer (INCR) is not read.
  - Rejected: a keyboard hook, which needs the Accessibility or Input Monitoring permission on macOS. An ad-hoc signed app loses that grant
    at every update, as the grant is tied to the signature. A global hotkey that copies the selection itself needs the same permission.

## 10. Settings

The app saves `settings.json` in the platform config directory (`crates/appdata/src/settings.rs`, shared with the host):
the selected model, the models folder if not the default, the license acceptance, the device and the last device measurement, the glossary, the UI language,
the theme, the UI size, the chunk and history sizes, synchronized scrolling, whether to check for new versions,
the double copy, and staying resident.
The language pair, style, context, auto-translate flag, and window geometry are not saved.
A file that does not parse (or is not UTF-8; a byte order mark is skipped) is kept as `settings.json.invalid`
instead of being overwritten.

## 11. Build, test, and distribution

- Development and day-to-day testing happen in WSL2 (Linux build, WSLg).
  WSLg has only a software Vulkan driver (lavapipe), so Vulkan inference cannot be tested there.
  ROCm, however, supports WSL2. The `rocm` feature (built with `scripts/rocm.sh`) runs the model on the RX 9070 XT from WSL2.
  For 2B Q4_K_M, generation runs at about 120–150 tok/s, against about 20 tok/s on the CPU.
  ggml also lists the integrated GPU, but only the discrete GPU's architecture is compiled, so it is not used there.
- Windows binaries are built natively on GitHub Actions `windows-2025` (MSVC, Windows SDK, and CMake are preinstalled;
  the Vulkan SDK is installed by the workflow), not cross-compiled. Cross-compiling from Linux fails:
  - The `gpui-pre-windows` build script compiles its HLSL shaders with `fxc.exe` only when the build host is Windows.
  - Release builds then `include!` the generated shader bytes, so a Linux-hosted release build cannot compile.
- CI runs on every push and pull request, with the latest stable Rust: rustfmt and clippy, and the tests, as parallel Linux jobs;
  clippy and the tests on macOS (Apple Silicon); and the extension's scripts and tests (Node).
  It builds no packages, so the slow parts (the Windows build, llama.cpp's Vulkan shaders, fat LTO) are not on every push.
- Build configurations:
  - Windows: features `engine/vulkan` and `engine/dynamic-backends`. llama.cpp is built as DLLs
    (`llama.dll`, `ggml*.dll`), and the backend modules sit next to the exe.
    - The exe and the DLLs import the Visual C++ runtime and OpenMP (`vcruntime140*.dll`, `msvcp140.dll`, `vcomp140.dll`).
      The package ships them from the toolset that built it, so the Redistributable need not be installed.
    - A machine without a working Vulkan driver simply does not list a Vulkan device.
    - Five CPU variants are shipped: `x64`, `haswell` (AVX2), `skylakex` and `icelake` (AVX-512), and `alderlake` (AVX-VNNI).
      ggml loads the best one the CPU supports.
    - Measured on a Ryzen 9 9950X with 2B Q4_K_M: generation is memory-bound (about 19.5 tok/s for every variant from AVX2 up).
      AVX-512 processes prompts about 25% faster than AVX2, and `x64` is roughly 25× slower at prompts.
    - A `zen4` variant (AVX-512 BF16, which MSVC cannot build) would add nothing for quantized models.
  - Modules are loaded only from the executable's folder.
    - The build output directory is searched only when the executable runs from that cargo target directory (`cargo run`).
    - If nothing loads, start-up fails instead of letting `llama_backend_init` search ggml's default paths, which include the current directory.
  - Linux: the same features as Windows.
    - The executables get `RUNPATH=$ORIGIN` from build scripts, so they find `libllama.so.0`, `libggml.so.0`, and `libggml-base.so.0` next to themselves.
      This is the executable's directory, never the current directory.
    - llama-cpp-sys-2 copies the versioned `.so` symlinks into the target directory without their targets, so packaging copies the files they point to (`cp -L`).
    - The package ships the Vulkan backend and the same five CPU variants as Windows.
      On native Linux with a Vulkan driver, the discrete GPU is used.
      WSL2 has no GPU Vulkan driver, so there the app uses the CPU, or the GPU through ROCm (`scripts/rocm.sh`).
    - Built on Ubuntu 24.04, so it needs glibc 2.39 or later. It also needs `libgomp1`, `libxkbcommon-x11-0`, `libxcb1`,
      a Vulkan driver (the UI renders with Vulkan), and a CJK font (for example `fonts-noto-cjk`; a minimal WSL image has none).
  - Packages use the `dist` profile (fat LTO, one codegen unit, stripped).
    The Linux app binary is 34.5 MB this way, against 73.7 MB for a release build with llama.cpp linked statically.
    Lints and tests run on Linux only, so Windows code is compiled only by the Release workflow.
  - The `translate` CLI is built and used for a smoke test (`--list-devices` with the package's own libraries), but it is not shipped.
- The Release workflow builds the packages, with the latest stable Rust:
  - Pushing a tag `vX.Y.Z` publishes a GitHub release with `SHA256SUMS.txt`. The tag must match the workspace version.
    The notes are the version's section of `CHANGELOG.md` (`scripts/changelog.sh`), followed by GitHub's generated notes.
  - A manual run (**Run workflow**, from any branch) builds the same packages as workflow artifacts without publishing,
    versioned `X.Y.Z-dev.<commit>`, plus the Windows `translate.exe` for testing the engine on Windows GPUs.
  - Windows: a portable zip with the app and the browser host (`plamo-translate-host`), the DLLs and backend modules,
    the Visual C++ runtime, the browser extension (`browser-extension/`), the READMEs, the licenses, and `THIRD-PARTY-NOTICES.txt`.
  - Linux: a tar.gz with the same contents (no Visual C++ runtime), a desktop entry, and its icon.
  - macOS (Apple Silicon, from v0.4.0): `scripts/package-macos.sh` on a macos-15 runner, a disk image with the app bundle (llama.cpp linked
    statically with Metal, the shaders embedded; the host, and the extension in `Contents/Resources`), signed ad hoc and not notarized.
    - The shaders are embedded as source and compiled on the user's Mac when the first context is created.
    - llama.cpp 0.8.0's shaders do not compile on macOS 14 and 15 with BF16 enabled, so the executables set `GGML_METAL_BF16_DISABLE`
      first thing in `main` (`engine::llama::configure_metal`). llama.cpp fixed this after 0.8.0 (#31360), and the PLaMo GGUF files have no BF16 tensors.
    - ggml aborts when the process exits with Metal buffers alive (`ggml_metal_rsets_free`, from a static destructor), so on macOS dropping a
      `Worker` waits for its thread to free the model, up to 10 s. Dropping one also stops a model load or a speed measurement in progress
      (the load's progress callback returns false, which makes llama.cpp stop and free what it allocated).
    - GPUI keeps a macOS application running without windows by default, so the app sets `QuitMode::LastWindowClosed`, and it adds the menu
      with Quit (Cmd+Q) that GPUI does not.
  - The browser extension alone (from v0.4.0, for its in-browser engine): a zip whose folder is the extension itself, as Load unpacked
    takes it (common for extensions outside the stores), with the licenses and the in-browser engine's notices (`scripts/notices.sh extension`);
    the README's section on it is online. The job checks that the manifest's version is the workspace's.
  - Windows for Intel NPUs: the Windows zip plus `ggml-openvino.dll`, the OpenVINO runtime and NPU plugin with oneTBB, and the OpenCL loader.
    The Windows build always includes the OpenVINO backend (`GGML_OPENVINO=ON`, built against the OpenVINO archive and the Khronos OpenCL SDK);
    only this package ships it. The OpenVINO DLLs come from the `openvino` wheel on PyPI of the same build, which is Apache-2.0,
    because the archive's runtime is under Intel's distribution license. Their notices are appended to `THIRD-PARTY-NOTICES.txt` (`licenses/intel-npu.txt`).
    llama-cpp-sys-2 forwards `GGML_*` variables to CMake but reruns only when one it saw changes, so the workflow cleans it when a restored cache has no `ggml-openvino.dll`.
  - On Windows, llama.cpp builds with Ninja in the MSVC environment: the Visual Studio 2026 generator runs the install step of ggml-vulkan's
    `vulkan-shaders-gen` external project before its build step on a fresh build (MSB8066).
  - `THIRD-PARTY-NOTICES.txt` is generated by `scripts/notices.sh`: cargo-about (`about.toml`, `about.hbs`) for the Rust crates,
    then `licenses/` for llama.cpp/ggml, wllama and what its build contains (Emscripten's runtime and C library with musl, Dawn's
    WebGPU bindings, JSON for Modern C++), the Lucide icons, and (Windows) the Visual C++ runtime.
  - Build caches are keyed on the rustc version. A tag can restore only its own caches and those of the default branch,
    so a manual run on `main` before tagging makes the release build warm.
- Windows-specific behaviour (DirectX rendering, IME, Vulkan performance on real hardware) is checked by running Release artifacts on the Windows host.
- Updates (from v0.5.0; crate `update`):
  - At start, unless turned off in Settings, the app shows a newer release found before and, once a day has passed since the last check
    (or the clock was set back), asks the GitHub API for the newest release (`releases/latest`, which leaves out drafts and pre-releases).
    The answer is kept in `update.json` in the data folder. A newer version shows in the status bar, linked to the release page.
    Settings' **Check now** asks at once and shows the result there. Failures are only logged; the next start asks again.
  - Versions are `major.minor.patch`, compared as numbers; tags are `v` and the same.
  - `PLAMO_TRANSLATE_UPDATE_URL` replaces the API address, for tests against a local server;
    `cargo run -p update --example latest` prints what the check finds, and `--example install -- <executable>` installs it as the app does.
  - Each package has `package.json` (`scripts/package-marker.py`, run by the release jobs once the folder is complete): its kind
    (`windows-x86_64`, `windows-x86_64-intel-npu`, `linux-x86_64`, `macos-arm64`) and its top-level entries. A build from source has none,
    and only links to the release page. The macOS app has it in `Contents/Resources`, with no entries: the app is replaced as a whole.
  - Clicking the status bar's notice opens a dialog; **Download and update** asks GitHub again (the check's answer may be a day old),
    fetches the newest release's package of the same kind and `SHA256SUMS.txt`, checks the digest, and unpacks it into a staging folder
    on the installation's volume: `update/new` in the app's folder, or next to the macOS app a hidden folder named after it
    (`.PLaMo Translate Desktop-update/new`, so that copies of the app side by side do not share it; `hdiutil attach`, then `ditto`).
    Archive paths that could leave the folder, and links, are refused. `ready.json` there records the version, so a prepared update
    survives a restart of the app, unless the last check knows a newer release. It waits for the start-up clean-up of that folder.
  - The executable's path is canonicalized without the `\\?\` prefix Windows gives it: the new version is started with that path, and
    the browser host's registration is compared with paths derived from it.
  - **Restart to update** writes `plan.json` and starts the new version's executable from the staging folder with `--apply-update`, its
    standard input a pipe from the app, then quits. The running app cannot replace its own files on Windows; the new executable waits for
    that pipe to close (the app has exited), moves the old package's entries into `old-<time>` and the new ones into place
    (retrying for a few seconds while a scanner holds a file), puts everything back if a step fails (recorded in `failed.txt`, which the
    app reports), and starts the app. If the app has not exited after a minute, nothing is swapped or started: renaming a running app's
    files would work and leave two copies running. A plan that cannot be read is recorded too, and the app is started again as it was. Only the package's entries move, so files the user put in the folder stay. Renaming works on files
    in use on Windows, so a browser host still running the old files does not block it. The next start removes the staging folder, or
    leaves what is still in use for later.
  - `plan.json` is written by one version and read by the next, so its fields are only ever added.
  - The extension: Chrome reads an unpacked extension's files from disk when they are requested, so when the panel opens it fetches its own
    `manifest.json` and, if the version there differs from the one loaded (the app swapped in a newer copy), offers **Reload**
    (`chrome.runtime.reload()`). That needs Developer mode, which Load unpacked needs anyway: without it, Chrome disables an unpacked
    extension when it reloads (`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`). The extension's own package has `package.json` too
    (`browser-extension`, no entries); with it, the panel asks GitHub at most once a day (`updateCheck` in storage) and links a newer
    release, unless **Check for new versions** in its settings is off. The app's copy has none: the app checks.
  - Settings shows the app's version next to **Check now**.
- Icon: a white block "p" on a blue rounded tile, after the PLaMo logo. `scripts/gen_icons.py` produces `assets/icon/`
  (SVG, a 256 px PNG, and a multi-size `.ico`) using only the Python standard library.
  On Windows, `crates/app/build.rs` embeds the icon as resource ID 1, which GPUI loads for its windows.
  On Linux, the window `app_id` is `plamo-translate-desktop`, matching `assets/plamo-translate-desktop.desktop`.
- Attribution: "Built with PLaMo" appears in the status bar, the Models dialog, and the README (PLaMo Community License, Article 4).
- Linux build dependencies: CMake and `libfontconfig-dev libwayland-dev libxkbcommon-x11-dev libx11-xcb-dev`,
  plus `libvulkan-dev glslc spirv-headers` for the Vulkan backend.

## 12. Browser extension

The extension (`extension/`) translates in the browser with the desktop app's model, through Chrome's native messaging,
or, from v0.4.0, on its own with an in-browser engine (see "In-browser engine" below).

- Components:
  - `plamo-translate-host` ships next to the app and shares its DLLs/shared libraries, models, and settings, so the package grows by about 1 MB.
    It has no GPUI dependency. It is a console program on Windows too, since Chrome starts hosts through `cmd.exe` with the window hidden.
  - The extension: context menu items for selected text ("Translate with PLaMo", shown in the side panel) and for the whole page,
    a shortcut for the whole page too (a manifest command with no suggested key, which grants `activeTab` like the context menu),
    the side panel, and `page.js` for page translation.
  - The selection shortcut (a manifest command with no suggested key) opens the panel and translates the text selected in the tab, as the context menu does,
    and puts the cursor in the panel's text box; with nothing selected, it only does the last. It is a command of its own because the toolbar button
    and its shortcut (`_execute_action`) open the panel through `openPanelOnActionClick`, which grants no `activeTab`.
    The selection is read once, at the press, only in the frame where the keyboard is (opening the panel takes the focus, so `document.hasFocus()`
    cannot tell), and never from masked fields. Pressed while the keyboard is in the panel, shown for a while, it leaves the panel's text as it is:
    the page's selection is then an old one. The keyboard moves to the panel only when the panel opens; F6 reaches an open one.
  - The panel's settings list the shortcuts with their keys (`chrome.commands.getAll`) and link to the browser's page for them
    (`chrome://extensions/shortcuts`, `edge://` in Edge, opened with `chrome.tabs.create` since a page cannot link there).
    Chromium lets an extension read its keys but not set them, and tells no change (no `commands.onChanged`, unlike Firefox),
    so the panel reads them again when it gets the focus or its settings open.
  - Requests to the panel (from the context menu and the selection shortcut) go through session storage with their window; only that window's panel takes them.
    One not taken within 30 s (that panel did not open) is dropped by the next panel that sees it, so opening the panel there later does not translate an old selection.
  - Texts come from `_locales` through `i18n.js` (shared by the panel, the background, and `page.js`). They follow the browser
    (`chrome.i18n`) unless the panel's display language picks a locale, whose `messages.json` is then read and filled in the same way;
    `page.js` gets those messages from the background (`ui_messages`) instead of reading the files itself.
    The manifest's name and description, and the shortcuts' descriptions on the browser's page, always follow the browser.
  - The background service worker (`background.js`) holds the one native port and shares it: panel translations start at once
    (interrupting a page batch, whose unfinished paragraphs go back to the queue), and page paragraphs go to the host in batches
    of up to 10 paragraphs or 2,000 characters while nothing else runs. Chrome keeps the worker alive while the port is open.
    The port closes after 5 minutes without work, or on Release in the panel.
- Registration (Settings → Browser extension → Connect, `crates/app/src/browser.rs`) writes a host manifest named
  `com.github.tanakh.plamo_translate` that points to the host and allows only the extension's ID:
  - Windows: the manifest in the data directory, referenced from `HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts`.
  - Linux: a copy in `NativeMessagingHosts/` of each browser that has a configuration directory (Chrome, Chromium, Edge, Brave), or Chrome's if none has.
  - The settings show whether the registration points to this copy of the app, so a moved app can be connected again.
- The extension's ID (`bcagbgackmnblhlofmpcmjfkfhhogpmh`) follows from the public key in its manifest, so the unpacked extension always has it.
  A Chrome Web Store release would get another ID, which must be added to `EXTENSION_IDS`.
- Protocol (`crates/host/src/protocol.rs`): length-prefixed JSON both ways.
  - Requests: `translate { id, text, target (code or auto), source, style }`, `translate_segments { id, segments, … }`, `cancel { id }` (the id is optional), `status`, `options`,
    and `configure { model, device }` (the extension's own choices; absent fields follow the app).
  - Responses: `status` (starting, loading, ready, no_model, error), `options` (downloaded models, devices, the current choices, and the device `auto` uses),
    `started`, `progress`, `text`, `segment { index, text }`, `rewind` (a UTF-16 length, as JavaScript counts),
    `done { tokens, cut, stopped, cancelled }`, and `error` with a code the extension localizes.
  - The host reads the app's settings before each request and reloads when the model or device changed.
    It uses the app's glossary, chunk and history sizes, and cut marker.
  - The panel's model and device choices are kept by the extension and sent in `configure` when it connects;
    the host loads nothing before the first request, so the app's model is not loaded only to be replaced.
    Writing them into the app's settings would have been undone by the app's next save.
  - A new request supersedes the running one, as in the app; the superseded one ends with `done { stopped, cancelled }`.
- Closing the port ends the host and frees the model's memory and the app's files (which Windows keeps locked while the host runs).
  The next request starts it again.
- Page translation (`page.js`, injected on request with `activeTab`, or from the panel with the optional all-sites permission):
  - Buttons in the side panel do not grant `activeTab`, and neither does the toolbar button: Chromium grants no tab permissions when the action
    opens a side panel (`openPanelOnActionClick`), since the panel stays across tab changes (`ExtensionActionRunner::RunAction`, crbug.com/40904917).
    The context menu and the shortcuts do, so the panel reaches a tab only after one of those was used on it,
    until the tab goes to another site. When the injection fails for want of a host permission, the panel offers the all-sites permission unless it is granted already;
    other failures (browser pages, the extension stores, error pages) say that the page cannot be translated. The notice sits under the page button.
  - Injecting into a page that has `page.js` already starts it again; it sends only runs not sent yet, and shows its box again even when there are none.
  - Closing the box ends the page translation, like Stop, and also stops watching for runs that show or are added later: otherwise the next
    translated paragraph would bring the box back. What is translated stays; translating the page again starts it again.
  - The page is cut into runs: consecutive text and inline elements within one block. Code, line breaks, and text marked `translate="no"`
    or `notranslate` stay as they are inside a run; `pre`, form controls, scripts, and similar are skipped, as are Japanese runs for a Japanese target (not for easy Japanese, which rewrites them).
  - A run is sent as simple HTML whose elements carry an index instead of their attributes (`see the <a i="2">guide</a>`).
    PLaMo 3 Translate keeps such tags in place and reorders them with the sentence (checked with 0.8B and 2B, HTML and Markdown).
  - The translation is parsed inertly (`DOMParser`) and rebuilt from text nodes and clones of the run's own elements, looked up by index,
    so links keep their targets and nothing the model writes can add attributes, elements, or scripts. Unknown or repeated indices keep only their text.
  - The runs in view go first; when scrolling stops, the pending runs in view move to the front of the queue (`prioritize`).
  - Runs that do not show (hidden by `display`, `visibility` or `opacity`, as `checkVisibility` tells, or taking no space) are
    kept back, and with the panel's `pageNearby` setting those more than a screen from the view too; they are sent when they show
    or come near, checked when scrolling stops and every two seconds (sections that open add no nodes).
  - The background tells the page which runs the host is on (`working`: the first not done of each batch running, since a batch
    goes in order), and page.js frames them in a layer of its own above the page (a shadow root with fixed boxes over each run's
    range, redrawn on scrolling and every half second), leaving the page untouched. The panel's setting `pageMarks` turns it off.
    Starting a page translation stops those of other tabs (their batch is cancelled at once); they can resume from their page.
    New content (infinite scrolling) is picked up by a `MutationObserver`. Stop keeps what is translated, and Resume sends the rest.
  - Replacing (the default) or showing the translation below the original (without the copies' ids); the original nodes are kept to restore the page.
  - The host's `translate_segments` translates the runs of a batch in order with the earlier ones as history (`engine::document::translate_segments`).
- Limits:
  - The host loads its own copy of the model, so with the app open the model is in memory twice. Relaying to a running app would avoid that.
  - Browsers installed as Snap or Flatpak packages on Linux cannot start programs outside their sandbox.
  - Firefox would need its own manifest format (`allowed_extensions`) and an extension build for it.
- In-browser engine (`engine.html`/`engine.js`, from v0.4.0): the extension translates without the app.
  - It runs [wllama](https://github.com/ngxson/wllama) (llama.cpp compiled to WebAssembly with Emscripten, with WebGPU) in an offscreen document,
    which the background opens (`chrome.offscreen`, reason `WORKERS`) and closes on release or after 5 minutes without work.
    It speaks the host's protocol over a port named `engine`, so the background shares it as it shares the host.
    The offscreen document sends `keepalive` every 20 seconds: Chrome keeps the service worker alive for a native port, not for a port to a page.
  - Engine selection (`engine` in the extension's storage): `app`, `browser`, or `auto`, which asks the host for its status first
    and uses the browser if the host does not start (not registered, or the app moved). Switching goes through the background (`set_engine`),
    which releases the current engine. Each engine keeps its own model and device choices (`choices`, `browserChoices`).
  - wllama is vendored in `extension/vendor/wllama`, built from source by `.github/workflows/wllama.yml` (`scripts/vendor-wllama.sh`):
    its npm releases (3.8.1) bundle a llama.cpp that predates the PLaMo 3 tokenizer (`plamo3`, which adds pre-segmentation to `plamo2`).
    Once a release bundles a newer one, it can be vendored instead. The build uses Memory64 and JSPI, hence Chrome 137 or later.
    It applies `patches/wllama`: `cache-ram.patch` adds the `cache_ram_mib` load parameter, with which the engine disables
    llama.cpp's prompt cache. That cache copies the KV state of the prompts a slot moves on from into memory, up to 8 GiB by default,
    past WebAssembly's 4 GiB: once it got that far, allocations failed (`std::bad_alloc`) and inference aborted.
  - Pages are cross-origin isolated (manifest `cross_origin_embedder_policy`/`cross_origin_opener_policy`) for WebAssembly threads,
    and the CSP allows `'wasm-unsafe-eval'`.
  - Models: the 0.8B and 2B Q4_K_M files of the app's catalog (WebAssembly's memory is limited to 4 GB), downloaded from Hugging Face
    into OPFS (resumed with a Range request, checked by size) after the panel's PLaMo Community License notice.
    - Versions as in the app (§7): the built-in list has the files of the release, with the date and title of the commit that last changed
      each. At most once a day, when the engine document starts, it lists both repositories (`tree/main?expand=true`) and keeps what it
      finds in `localStorage` (`catalog`); a newer file replaces the built-in entry. The check never holds up a translation, and a failure
      (offline) changes and shows nothing: the downloaded models work as before, and the next start tries again (15 s timeout).
    - A file of another version is used as it is. The panel shows "A newer version is out (date)" under its row (the commit title as
      the tooltip) and Update, which downloads the newer file beside it and then replaces it, after any load in progress (a loaded model
      is in memory and stays in use).
    - The start of the engine document also removes the partial downloads of other versions and the `.crswap` files a write leaves when
      its document closes, which OPFS never reuses (one of 592 MB was found).
  - Prompts and long texts (`translator.js`, tested by `tests/extension/translator.test.mjs`): a port of `pfml`'s prompt format and of
    the chunks with history, with token counts estimated from characters, smaller chunks (512) and history (768 tokens) because
    WebAssembly reads prompts several times slower, and history that drops pairs several at a time so that consecutive prompts share
    their beginning (llama.cpp reuses it). Output that runs away is cut by a token limit instead of the app's retries.
    wllama tokenizes the prompt as one string, special tokens included, so `<|` in the text gets a zero-width space.
  - Devices: `cpu` (WebAssembly threads) and `gpu` (WebGPU). llama.cpp's WebGPU backend requests an adapter without a power preference,
    which gets the integrated GPU beside a discrete one; `engine.js` wraps `URL.createObjectURL` so that wllama's worker code starts by
    defaulting `requestAdapter` to `high-performance`. On `auto`, the first load measures both (a warm-up text, then a different one,
    since llama.cpp would reuse the same prompt) and keeps the faster, saved with the GPU's name and the core count.
    The panel's Measure and choose measures again (`measure { id }`, a job like a panel translation: page batches wait for it), and
    `options` carry what `auto` uses and the speeds, which the panel shows (`Automatic (GPU)`, as the app's settings do).
  - The background tells the panels which engine the automatic setting uses (`engine { setting, auto }`), probing the app's host once
    if nothing is connected, so the engine list shows it.
  - The status reports the device llama.cpp really uses, from its messages while loading (the WebGPU adapter, at the log level, and
    the layers offloaded, at the debug level): without an adapter in wllama's worker it computes on the CPU, and `auto` then does not
    count the GPU's measurement. On the CPU, `configure { threads }` sets wllama's `n_threads` (the panel offers powers of two up to the logical cores).
  - Page batches run side by side, four at once (`slots` in the engine's status; the app's host runs one): llama.cpp decodes their
    tokens together, which costs little more per step than one. Each batch keeps its order and its own history, so the prompts are
    the ones a lone batch would get; the outputs differ only where batched kernels round differently (a word here and there).
    - The engine loads four slots of `N_CTX` tokens, each with its own KV cache (`kv_unified: false`): with one cache shared by all
      (wllama's default), every step attends over all the sequences, and two concurrent translations ran five times slower than one.
    - Segments are generated without streaming. Each poll for a result runs one step of llama.cpp's loop, and a stream polls once
      per token, so streamed batches took as many steps side by side as one after another.
    - The batches run in rounds: the next paragraphs (four batches' worth) are dealt among them in turn, the first taking 1, 5, 9…,
      and the next round starts when the last of this one ends. The paragraphs translated at once are next to each other, so the page
      fills from the top instead of in four places; each batch's history is the paragraphs four before. Measured as below: 47 s
      (consecutive batches side by side took 49 s, one at a time 70 s). The panel's `parallelPages` setting turns it off.
    - A panel translation stops all the batches (they are sent again after it), so it runs alone at full speed.
      `cancel` takes the job's `id`; the app's host ignores it.
    - Measured on a Radeon RX 9070 XT with 80 paragraphs, from the model loaded to the last: 2B 66 s one batch at a time, 46 s
      side by side (53 s with the prompt cache, whose copies cost time too); replaying the same flow, 0.8B 48 s and 34 s, and on the
      CPU 102 s and 87 s. The prompts, which batching does not speed up, take about half the time (WebGPU reads 2B prompts at about
      180 tok/s).
  - Speeds in the panel: the pieces of text received (one token each, from either engine) over the time since the first.
    For page translation, the background counts the tokens of the page's batches (each `segment` of the in-browser engine carries
    its tokens; the app's host reports them in `done`) over the time since its first batch started.
    The background also reports the tabs whose page translation runs (`pages`), so the panel's page button stops the active tab's.
  - On WebGPU, 0.8B and 2B differ little in speed (12.2 and 14.5 ms per token): a fixed cost per token dominates, the 600–900
    dispatches of the graph each crossing to the GPU process and the logits read back before the next token, while native code
    reads them from mapped memory in microseconds. Decoding page batches side by side shares that cost.
  - Measured with 2B Q4_K_M: Radeon 8060S 48 tok/s, Radeon RX 9070 XT 67 (native Vulkan 246), CPU of a Ryzen 9 9950X 18 (native 20);
    prompts on the CPU at about 33 tok/s (native 250). Chrome uses the GPU Windows assigns to it: on a PC whose display runs on the
    integrated GPU, the graphics settings must give Chrome the discrete one.

## 13. Status and later work

Done for v0.1.0: feasibility (M0), the two-pane MVP (M1), model management (M2), device selection (M3),
translation options and long texts (M4), and distribution (M5: Release workflow, icon, third-party notices, desktop entry).
Then v0.2.0 (2026-11-06): the browser extension (§12); v0.2.1: clearer failures of page translation from the panel.
v0.3.0: Intel NPUs through OpenVINO, and automatic device selection that measures the devices (§8).
v0.4.0 (2026-11-07): the extension's in-browser engine (§12), the macOS package (Apple Silicon), and the extension alone as a package.
v0.5.0 (2026-11-10): updates of the app, which the extension follows (§11), new versions of the models (§7), the models folder,
and the UI size (§9).

Possible later work:

- Reuse the KV cache prefix between chunks (each request starts from an empty cache today).
- Partial GPU offload for models larger than the GPU memory.
- An AppImage or distribution packages for Linux; signing the Windows executable; notarizing the macOS app.
- A shortcut that translates the clipboard (besides the double copy), the macOS Services menu, and a tray icon on Linux (§9.1).
- Remote inference backends (§1).

## 14. Risks

| Risk | Status |
|---|---|
| The `plamo3` implementation in the vendored llama.cpp differs from the reference | Resolved: CLI output matches the model card examples |
| `llama-cpp-2` releases lag behind llama.cpp | Open: pinned to a git revision; move back to crates.io once a release vendors llama.cpp ≥ 0.8.0 |
| `dynamic-backends` with Vulkan does not build on Windows MSVC | Resolved: the Release workflow builds it |
| IME or text input gaps in gpui-kit's textarea | Open: patch or contribute upstream if reported |
| gpui-pre snapshots break the API often | Open: exact versions are pinned and updated deliberately |
| Long llama.cpp + Vulkan shader builds in CI | Resolved: packages are built only in the Release workflow, with cached target directories |
| Small models loop or skip text in long outputs | Mitigated: small chunks, loop detection, retries, and cut markers (§6.1) |
