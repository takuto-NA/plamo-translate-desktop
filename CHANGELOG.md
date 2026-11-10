# Changelog

All notable changes to PLaMo Translate Desktop. Each release's section here also becomes its release notes on GitHub.

## [Unreleased]

### Added

- **Translate when copied twice** in Settings ([#7](https://github.com/tanakh/plamo-translate-desktop/issues/7)): select text in any application and press Ctrl+C twice quickly (⌘C on macOS), and the app's window comes to the front and translates it. Only the clipboard is watched, not the keyboard, so no permission is needed. Off by default. On Linux it needs X11, or Xwayland in a Wayland session.
- **Keep running when the window is closed** in Settings: the app keeps running without its window, which opens again from the icon in the notification area (Windows), the Dock (macOS), or by starting the app again (Linux). The model is released meanwhile and loaded again when the window opens. Off by default. Ctrl+Q (⌘Q) quits.
- **Keyboard shortcuts** under **Settings** in the browser extension's panel shows the keys of its shortcuts, and **Set in the browser** opens the browser's page where they are set (`chrome://extensions/shortcuts`, or `edge://extensions/shortcuts` in Edge). The browser does not let an extension set its keys itself.

### Changed

- Starting the app while it runs brings its window to the front, instead of starting a second copy that loads the model again.

## [0.5.0] - 2026-11-10

### Added

- The app updates itself: it asks GitHub at most once a day whether a new version is out, and the status bar then says so. Clicking it downloads the new version (checked against `SHA256SUMS.txt`), and **Restart to update** starts the new version. Files added to the app's folder stay. **Check for new versions** in Settings turns the check off, and **Check now** asks at once. Settings also shows the app's version.
  - Version 0.4.0 and earlier cannot update themselves: install this version by hand as before (replace the app's files with the new package's). From this version on, the app updates itself.
- When PFN publishes a new version of a downloaded model, its row in the Models dialog says so, with the date, and **Update** downloads it (the button's tooltip says what changed). The model stays usable meanwhile; the one in use is loaded again once the new file is in place.
- The folder models are kept in can be changed: **Change…** next to it in the Models dialog, for example to keep them on another drive or share them with other tools ([#6](https://github.com/tanakh/plamo-translate-desktop/issues/6)). Models already downloaded stay where they are. The browser extension's host uses the same folder.
- **UI size** in Settings (100–200%) enlarges the interface on top of the display scaling of the OS, for a high-DPI display that a Linux desktop does not scale ([#5](https://github.com/tanakh/plamo-translate-desktop/issues/5)). The window opens larger to match.
- The browser extension follows the app's updates: when the app has updated its copy of the extension, the panel offers **Reload** to load the new version. The extension's own package says in the panel when a new version is out (at most once a day; **Check for new versions** in its settings turns this off).
- The browser extension's in-browser engine also tells about new versions of its models: a newer version on Hugging Face (asked at most once a day; offline, nothing changes) shows under the model in **Settings**, with **Update**. A model downloaded before stays usable.
- A keyboard shortcut in the browser extension translates the page, as **Translate this page with PLaMo** in the right-click menu does. It has no key at first: set one at `chrome://extensions/shortcuts`.
- A keyboard shortcut in the browser extension opens the side panel and translates the selected text there, as **Translate with PLaMo** in the right-click menu does; with nothing selected, it puts the cursor in the panel's text box. It has no key at first: set one at `chrome://extensions/shortcuts`.

### Changed

- The built-in model lists of the app and of the in-browser engine point to the files of 2026-11-08.
- Closing the box of a page translation (×) ends the translation of the page. It came back with the next translated paragraph. What is translated stays, and translating the page again goes on with the rest.

### Fixed

- A downloaded model no longer disappears from the Models dialog when PFN publishes a new version of its file, and is loaded at start as before ([#6](https://github.com/tanakh/plamo-translate-desktop/issues/6)). PFN replaced every file four times by 2026-11-08, changing only the chat template, which the app does not use; a file counted only at the newest version's size. Now a downloaded file is used whatever its version.
- The in-browser engine removes what interrupted downloads left in the browser's storage (swap files of hundreds of megabytes were left behind).
- **Translate with PLaMo** in the browser extension shows the translation in the side panel of the window it was chosen in. A side panel open in another window could take it.
- A translation asked for from the right-click menu or the selection shortcut whose side panel did not open is dropped after 30 seconds. Opening the panel in that window later translated the old text.
- The extension's README and its notice under **Translate this page** said that the toolbar button lets the panel into a tab. It does not: the browser grants nothing when the button opens the side panel. They now name the right-click menu and the shortcuts only.

## [0.4.0] - 2026-11-07

### Added

- macOS (Apple Silicon) support. `scripts/package-macos.sh` builds the package: the app in a disk image, for macOS 13.3 or later. llama.cpp runs on the GPU through Metal. The Releases page has it as `…-macos-arm64.dmg`. It is not notarized: the README says how to open it.
  - **Connect** registers the browser host with Chrome, Chromium, Edge, and Brave in `~/Library/Application Support`. It used to write to `~/.config`, where only their Linux versions look.
  - The GPU is used on macOS 14 and 15 as well, where llama.cpp 0.8.0's Metal shaders do not compile with BF16 enabled (the PLaMo models do not use BF16).
  - The app has a menu with Quit (Cmd+Q) and quits when its window is closed. Quitting while a model is loaded, or while one is loading, exits cleanly, in the app and in the browser host.
  - Models on the GPU stay memory-mapped, since Metal uses the mapped file directly: with 0.8B, a peak of about 200 MB of memory instead of 760 MB, at the same speed.
- The browser extension translates on its own too, with the model running in the browser: [wllama](https://github.com/ngxson/wllama) (llama.cpp compiled to WebAssembly) on the CPU or the GPU (WebGPU). The app is not needed for it. See "Without the app" in the README.
  - **Engine** under Settings in the panel: Automatic (the app when it is connected, otherwise the browser), PLaMo Translate Desktop, or In the browser.
  - The 0.8B and 2B models (Q4_K_M), downloaded into the browser from the panel after accepting the PLaMo Community License (resumed after a network error, and deletable). The larger ones do not fit in WebAssembly's memory.
  - Device: Automatic measures the CPU and the GPU on the first translation and keeps the faster one; it asks for the high-performance GPU (the README explains Windows' GPU assignment). With 2B, generation runs at about 48 tokens/s on a Ryzen AI Max+ 395 (Radeon 8060S), 67 on a Radeon RX 9070 XT, and 18 on the CPU of a Ryzen 9 9950X.
  - Released after 5 minutes without use, or with Release, like the app's host.
  - The panel links to the README's steps for setting up the app, which the larger models need.
  - A package with the extension alone (`…-browser-extension.zip`), for trying it without the app.
  - The status shows the device really used, such as `WebGPU (amd rdna-4)`, and says so when the GPU could not be used. With the device set to the CPU, the number of threads can be chosen under Settings.
  - Page translation runs four batches of paragraphs side by side, dealt in turn so that the page fills from the top: with 2B on a Radeon RX 9070 XT, 80 paragraphs take 47 s instead of 70. Each paragraph then has less of the text just before it as context; **Translate pages in parallel** under Settings turns it off.
- The panel shows the speed in tokens per second while it translates and when it is done, and the box on a translated page shows the page's speed.
- While the page in the current tab is being translated, the panel's page button stops it.
- A pulsing frame on the page marks the paragraphs being translated (with the in-browser engine, up to four at once). **Settings** in the panel can turn it off.
- Page translation skips paragraphs that do not show (collapsed sections, menus, hidden text) until they do. **Settings** in the panel can also limit it to the paragraphs near the view, translating the rest as you scroll to them.
- The panel shows what Automatic uses: the engine (the app or the browser) and the device, such as **Automatic (GPU)** with the speeds measured in the browser, or the device the app measured. **Measure and choose** under the device measures the browser's GPU and CPU again.
- Reset settings under Settings in the panel: back to a first start (the license acceptance, the choices, the measured device); downloaded models are kept.

### Changed

- The extension needs Chrome or Edge 137 or later.

### Fixed

- Downloads in the app: PFN replaced every model file on 2026-11-06 (only the chat template changed, which the app does not use), and the files of the first revision are no longer served. The built-in model list now points to the new revision, and models downloaded before still count as downloaded.
  - Partial downloads of the first revision, which can no longer be resumed, are removed (they could be gigabytes, and were neither shown nor deleted).
- Output that repeats itself is retried with the repetition penalty (DRY) as designed: a setting of llama.cpp's had left it off, so the last retry ran the same way as the first.
- With Auto off, a model that finishes loading no longer starts a translation, unless one was asked for while it loaded.
- A download finishing no longer replaces a model chosen while it ran; the first download to finish becomes active only when no model is.
- Swapping with Japanese ⇄ English as the target and an explicit source language sets the source to the translation's language.
- Unloading or deleting a model while it loads no longer leaves "Loading… 100%" in the status bar, and a model whose files cannot be deleted stays selected.
- A `settings.json` saved with a byte order mark is read, and one in another encoding than UTF-8 is kept aside instead of being overwritten.
- The browser extension: closing the panel while it translated no longer stopped a page translation in progress; a page translation that fails stops all its batches; translations of a stopped page translation no longer reach the next page in the tab; and only the extension's own pages can connect as its panel.

## [0.3.0] - 2026-11-06

### Added

- A Windows package for Intel NPUs (`…-windows-x86_64-intel-npu.zip`): the regular package plus llama.cpp's OpenVINO backend and the OpenVINO NPU runtime. The NPU shows up as a device named NPU in Settings (and in the extension's panel), next to the CPU and the GPUs; Automatic does not choose it.
  - On the NPU the context is 8192 tokens (long texts are translated in correspondingly smaller chunks), since its graphs have fixed shapes.
  - The first translation after loading a model compiles it for the NPU, which takes a while; the compiled graphs are cached in `openvino-cache` in the data folder, so later starts are faster.
  - The NPU is for using less power and leaving the GPU free rather than for speed. On a Core Ultra 7 356H, 2B translates at about 30 tokens/s on the NPU, 40 on the CPU, and 70 on the integrated GPU.
- **Measure and choose** next to the device in Settings: translates a short text with the current model on the CPU and each GPU, shows their speeds, and makes Automatic use the fastest. Useful after a hardware change.

### Changed

- On a PC with an integrated GPU and no discrete one, the first model load measures whether the CPU or the integrated GPU is faster, and Automatic uses that one (it used to take the CPU). The status bar says that this happens on the first start only. Integrated GPUs range from much slower than the CPU to much faster, such as the Radeon 8060S of Ryzen AI Max processors.
- With the device set to CPU, translation runs on the CPU only. llama.cpp used to hand large operations to a GPU as well.

### Fixed

- Windows packages build again from a clean cache: llama.cpp is now built with Ninja, as the Visual Studio 2026 generator ran its steps out of order.
- On a GPU, the time spent reading the text was counted as generation, so the speed shown was a little low (and the prompt speed in the `translate` CLI far too high).

## [0.2.1] - 2026-11-06

### Fixed

- Translate this page in the extension's panel seemed to do nothing at times. The browser lets the panel into a tab only after the toolbar button or the right-click menu was used on it, so the button fails on other tabs, such as after switching tabs or going to another site. The explanation now shows right under the button instead of at the bottom of the panel, and offers to allow the extension on all sites only where that helps: pages that extensions cannot enter, such as the browser's own pages, now say so.
- Asking again to translate a page that is translated already now shows its box again (it stayed hidden if it was closed).

## [0.2.0] - 2026-11-06

### Added

- A browser extension for Chrome and Edge (`browser-extension/` in the packages) that translates with the desktop app's model. It talks to `plamo-translate-host`, a small program that ships next to the app; the app does not need to be running. See "Browser extension" in the README.
  - Translate selected text from the context menu, or text typed or pasted into the side panel, into any of the app's target languages and styles. The translation streams in.
  - Translate a whole page in place, keeping links and formatting. Paragraphs in view go first, and the ones you scroll to move ahead. The box on the page can stop, resume, or restore the original. Starting another page stops the previous one, which can be resumed later. Translations can also be shown below the original instead.
  - Choose the model (any downloaded one) and the device in the panel, independently of the app's selection.
  - Release frees the model's memory, including GPU memory. The host also ends by itself after 5 minutes without use, and starts again with the next translation.
  - The extension's texts follow the browser's language, or English or Japanese as set under Display language in the panel's settings.
- Settings → Browser extension in the app: Connect registers the host with Chrome and Edge (on Linux also Chromium and Brave), Disconnect removes the registration, and Open extension folder shows the folder to load into the browser. The section also shows when the browsers use another copy of the app, such as one moved or unpacked elsewhere.

### Known limitations

- The host loads its own copy of the model, so with the app open as well the model is in memory twice.
- Browsers installed as Snap or Flatpak packages on Linux cannot start the host. Firefox is not supported.

## [0.1.0] - 2026-11-05

The first release.

- Local translation between 53 languages with PLaMo 3 Translate through llama.cpp, offline once a model is downloaded. The default target is Japanese ⇄ English (automatic).
- Translation as you type or paste, streamed as it is generated, with the progress, speed, and remaining time in the status bar.
- Japanese output style (polite or plain), a reference context, and a glossary.
- Long texts translated paragraph by paragraph with earlier pairs as history. Output that falls into a repetition loop is detected and translated again in smaller pieces; a passage that keeps looping is cut and marked. Chunk and history sizes are adjustable.
- A model manager for the 0.8B, 2B, 8B, and 31B GGUF files, with PFN's published quality figures, resumable and verified downloads, and the PLaMo Community License shown before the first download.
- CPU (AVX2 or AVX-512) and Vulkan GPU inference, with a selectable device; ROCm for Linux source builds.
- English and Japanese UI, light and dark themes, and synchronized scrolling between the source and the translation.
- Packages for Windows and Linux (x86-64), with third-party notices.

[Unreleased]: https://github.com/tanakh/plamo-translate-desktop/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/tanakh/plamo-translate-desktop/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tanakh/plamo-translate-desktop/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tanakh/plamo-translate-desktop/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/tanakh/plamo-translate-desktop/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tanakh/plamo-translate-desktop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tanakh/plamo-translate-desktop/releases/tag/v0.1.0
