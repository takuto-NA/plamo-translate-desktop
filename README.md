# PLaMo Translate Desktop

[日本語](README.ja.md)

A desktop translation app that runs [PLaMo 3 Translate](https://www.preferred.jp/ja/blog/tech/plamo-3-translate-weight-release)
locally on your computer. It works offline once a model is downloaded. Written in Rust with [GPUI](https://www.gpui.rs/).

**Built with PLaMo.**

## Features

- Translation between 53 languages. The default target is "Japanese ⇄ English (auto)".
- Paste to translate; text you type is translated after a short pause (the Auto switch in the toolbar turns this off). The translation streams in as it is generated, with the progress, speed, and remaining time in the status bar, and can be stopped at any time.
- Japanese output style (polite or plain), a reference context, and a glossary (`source = target`, one term per line).
- Long texts are split into paragraphs and translated in order, with earlier pairs passed as history to keep wording consistent.
  Output that falls into a repetition loop is detected, withdrawn, and translated again in smaller pieces. A passage that keeps looping is cut and marked in the translation.
- Built-in model manager: choose a model size and quantization (0.8B, 2B, 8B or 31B GGUF).
  - Each file shows the translation quality PFN publishes, with the difference from the unquantized model.
  - Downloads resume after an interruption and are verified with SHA-256.
  - Newly published files are picked up from Hugging Face without an app update.
  - **Change…** next to the folder in the dialog keeps the models elsewhere, for example on another drive or in a folder shared with other tools
    (the file names must be those the app uses, such as `plamo-3-translate-2b-Q4_K_M.gguf`). Models already downloaded are not moved.
    When PFN publishes a new version of a file you have, it stays usable, and its row says so with the date; **Update** downloads it.
- Runs on the CPU (AVX2 or AVX-512) or on a GPU through Vulkan. Linux source builds can also use ROCm. The device is selectable; Automatic uses the fastest one measured on this PC, or else the discrete GPU.
- English and Japanese UI. It follows the OS language by default and can be changed under Settings (the gear in the status bar). `PLAMO_LANG=ja` or `en` overrides both.
- Light and dark themes. The default follows the OS; Settings can fix either one.
- **UI size** in Settings (100–200%) enlarges the interface on top of the display scaling of the OS, for a high-DPI display the desktop does not scale.
- The source and the translation scroll together, and moving the caret in one selects the corresponding paragraph in the other (can be turned off in Settings).
- **Translate when copied twice** (Settings, off by default): select text in any application and press `Ctrl+C` twice quickly (`Cmd+C` on macOS),
  and the app's window comes to the front and translates it. Only the clipboard is watched, not the keyboard, so no permission is needed.
  On Linux this needs X11, or Xwayland in a Wayland session.
- **Keep running when the window is closed** (Settings, off by default): the app keeps running without its window, and releases the model meanwhile.
  The window opens again from the icon in the notification area (Windows), the Dock (macOS), or by starting the app again (Linux).
  Starting the app while it runs brings its window to the front.
- Updates: the app asks GitHub at most once a day whether a newer release is out, and the status bar then says so.
  Clicking it downloads the new version (checked against `SHA256SUMS.txt`), and **Restart to update** then starts the new version.
  Files you added to the app's folder stay. A build from source only links to the release page.
  **Check for new versions** in Settings turns the check off; **Check now** there asks at once, next to the app's version.

Shortcuts: `Ctrl+Enter` translates now. `Ctrl+Shift+C` copies the translation. `Ctrl+Q` quits. On macOS these are `Cmd+Enter`, `Cmd+Shift+C`, and `Cmd+Q`.

## Models and their license

The app does not ship model weights. When you pick a model in the app, it downloads it from
[Preferred Networks on Hugging Face](https://huggingface.co/pfnet). The models are licensed under the
[PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-en)
([Japanese](https://plamo.preferredai.jp/info/plamo-community-license-ja)), and the app asks you to accept it before the first download.

- **Personal and non-commercial use** is free.
- **Commercial use**, including use inside an organization, requires
  [registration](https://forms.gle/mTL8tBLrMYXKNZD56) if your (or your affiliates') annual revenue is ¥1 billion or less.
  Above that, a separate license from Preferred Networks is required.
- If you publish translations produced by the model, indicate that they are PLaMo output (Article 5).

PLaMo is a trademark of Preferred Networks, Inc.

## Download

Windows (x86_64), Linux (x86_64) and macOS (Apple Silicon) packages are on the [Releases](https://github.com/tanakh/plamo-translate-desktop/releases) page,
with their SHA-256 checksums in `SHA256SUMS.txt`. For the latest changes, build from source (below).

- **Windows** (10 or later): unzip and run `plamo-translate-desktop.exe`. Keep the DLLs next to it:
  llama.cpp and its CPU and Vulkan backends are loaded from there, and only from there.
  The Visual C++ runtime is included, so nothing else needs to be installed.
- **Windows with an Intel NPU** (Core Ultra; experimental): the `-intel-npu` zip is the same app plus OpenVINO's NPU runtime.
  Choose **NPU** as the device in **Models and device** (the model button in the status bar); Automatic does not choose it. The first translation after a model loads
  compiles it for the NPU, which takes a while; the result is cached for later starts. On the NPU the context is 8192 tokens,
  so long texts go in smaller chunks. The NPU driver comes with the PC's drivers or Windows Update.
  The NPU is for using less power and leaving the GPU free rather than for speed: on a Core Ultra 7 356H, 2B translates
  at about 30 tokens/s on the NPU, 40 on the CPU, and 70 on the integrated GPU (Vulkan).
- **Linux**: extract and run `plamo-translate-desktop`. The shared libraries next to it are found through the executable's own directory (`RUNPATH=$ORIGIN`).
  - It is built on Ubuntu 24.04 and needs glibc 2.39 or later (Ubuntu 24.04, Debian 13, Fedora 40, or newer),
    plus `libgomp1`, `libxkbcommon-x11-0`, and `libxcb1`, which desktop installations usually have.
  - It needs a Wayland or X11 session with a Vulkan driver, which the UI uses for rendering and translation can use on the GPU, and a CJK font such as `fonts-noto-cjk`.
  - The app follows the display scaling of the desktop. If it looks too small on a high-DPI display (some desktops, X11 ones in particular,
    do not scale it), raise **UI size** in Settings.
  - To add it to the application menu, run this in the extracted folder:

    ```sh
    mkdir -p ~/.local/share/applications ~/.local/share/icons/hicolor/256x256/apps
    sed "s|^Exec=.*|Exec=\"$PWD/plamo-translate-desktop\"|" plamo-translate-desktop.desktop \
      > ~/.local/share/applications/plamo-translate-desktop.desktop
    cp plamo-translate-desktop.png ~/.local/share/icons/hicolor/256x256/apps/
    ```
- **macOS** (13.3 or later, Apple Silicon): open the disk image (`-macos-arm64.dmg`) and drag the app into Applications.
  Translation uses the GPU through Metal. The app is not notarized, so macOS refuses to open the downloaded copy at first:
  run `xattr -dr com.apple.quarantine "/Applications/PLaMo Translate Desktop.app"` in Terminal, or try to open it once and
  choose **Open Anyway** under System Settings → Privacy & Security.
- **Browser extension only** (`-browser-extension` zip, Chrome or Edge 137 or later): the extension without the app,
  which translates with the model running in the browser. The unzipped folder is the extension; see [Without the app](#without-the-app).

On Windows and Linux, translation uses a discrete GPU through Vulkan when one is available, and otherwise the fastest CPU code path the CPU supports (AVX2 or AVX-512).
On a PC with an integrated GPU and no discrete one, the first model load measures whether the CPU or the integrated GPU translates faster
(integrated GPUs range from much slower to much faster), and Automatic uses the faster one.
**Measure and choose** next to the device in **Models and device** (the model button in the status bar) measures all of them again,
for example after a hardware change.

## Browser extension

The packages include an extension for Chrome and Edge 137 or later (`browser-extension/`) that translates text in the browser with the model selected in the app.
Install the app first (see [Download](#download)), then:

1. In the app, open Settings (the gear in the status bar) and choose **Connect** under Browser extension.
   This registers the bundled `plamo-translate-host` with Chrome and Edge (on Linux and macOS also Chromium and Brave).
2. Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose **Load unpacked**,
   and select the `browser-extension` folder (**Open extension folder** in the same Settings section).
   On macOS the folder is inside the app, which the dialog does not open: press `Cmd+Shift+G` in it and enter
   `/Applications/PLaMo Translate Desktop.app/Contents/Resources/browser-extension`.
3. Select text on a page, right-click, and choose **Translate with PLaMo**: the side panel shows the translation as it streams in.
   The toolbar button opens the panel to type or paste text. A keyboard shortcut translates the selected text too: **Keyboard shortcuts** under **Settings** in the panel shows the keys
   and opens the browser's page where they are set (`chrome://extensions/shortcuts`; none is set at first).
4. To translate a whole page, right-click it and choose **Translate this page with PLaMo** (or **Translate this page** in the panel,
   or its keyboard shortcut).
   The browser lets the panel's button into a tab only after the right-click menu or one of the shortcuts was used on it (the toolbar button
   does not count), until the tab goes to another site; on other tabs the panel offers to allow the extension on all sites.
   Paragraphs are translated in place, keeping links and formatting: those in view first, and when you scroll, the ones you scrolled to.
   Hidden ones (collapsed sections, menus) wait until they show. **Settings** in the panel can limit it to the paragraphs near the view,
   translating the rest as you scroll to them.
   A box at the bottom right shows the progress and can stop, resume, or restore the page; closing it ends the page's translation
   (what is translated stays). A frame marks the paragraphs being translated (**Settings** in the panel can turn it off).
   Translating another page stops this one, which can be resumed later.
   **Pages** under **Settings** in the panel shows translations below the original instead.
5. A PDF open in the browser is translated the same way (the right-click menu, the panel's button, or the shortcut):
   it opens in a new tab, in a viewer of the extension's own, with each paragraph's translation over the paragraph. Figures, tables, and formulas stay as they are.
   **Original** shows the PDF as it was; pointing at a translated paragraph shows its original text.
   - **Save as PDF** opens the browser's print dialog: choose **Save as PDF** as the destination. The translations are saved as text
     over an image of each page. Paragraphs not translated yet are saved as in the original.
   - The viewer keeps the PDF and its translations in the browser, so reloading the tab, or restoring it with the browser, goes on
     where it was instead of translating again. Only the last 5 PDFs opened are kept (256 MB at most together, and none for more than 30 days).
     **Translate again** discards a PDF's translations and starts over.
   - Only PDFs with text in them: pages that are images, such as scans, cannot be translated (the viewer says so). Vertical and rotated text stays as it is.
   - From the right-click menu, the browser's PDF viewer gives the extension no access to the PDF: the extension's viewer then asks for
     access to the PDF's site (**Allow access to …**), once for each site. The shortcut needs no such step.
   - For a PDF on this computer (`file://`), turn on **Allow access to file URLs** in the extension's details (`chrome://extensions`).
     Where it is off, the viewer says so, with a button that opens the details. Changing it restarts the extension, which closes the viewer's tab: translate the PDF again.
     Opened from the right-click menu, the viewer may also ask for access to files (**Allow access to files**), once.

When the app updates itself, the extension in its folder is updated with it, and the panel offers **Reload** to load the new version
(Developer mode must stay on: Chrome disables unpacked extensions without it).

The extension's texts (the panel, the menus, and the box on the page) follow the browser's language;
**Display language** under **Settings** in the panel sets English or Japanese instead, independently of the app.

The host uses the model and device selected in the app unless you choose others under **Settings** in the panel
(any downloaded model; downloads stay in the app). It loads its own copy of the model, so with the app open as well the model is in memory twice.
It ends, freeing the memory, after 5 minutes without use or when you choose **Release** in the panel; the next translation starts it again.
To update the app in place, release it and close the app first (the host keeps its files open). If you move the app's folder, choose Connect again.
**Disconnect** in the same section removes the registration from the browsers (on Windows, from the registry); do this before deleting the app.
Browsers installed as Snap or Flatpak packages on Linux cannot start the host.

### Without the app

The extension can also translate on its own, with the model running in the browser
([wllama](https://github.com/ngxson/wllama): llama.cpp compiled to WebAssembly).

The browser extension package (`plamo-translate-desktop-X.Y.Z-browser-extension.zip` on the
[Releases](https://github.com/tanakh/plamo-translate-desktop/releases) page) has the extension alone, to try it without installing the app:

1. Unzip it. The folder it makes is the extension; keep it where it is, since the browser loads the extension from there.
2. Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose **Load unpacked**, and select that folder.
   Chrome and Edge install extensions from files only through their stores, hence Load unpacked.
3. Open the panel with the toolbar button and download a model under **Settings** (see below).

The panel says when a new version is out (it asks GitHub at most once a day; **Check for new versions** under **Settings** turns this off).
To update, replace the folder's files with the new version's: the panel then offers **Reload** (or press the reload button on the extension
in `chrome://extensions`). The settings and the downloaded models are kept. For the larger models and faster translation, install the app later (see [Download](#download))
and choose **Connect** in its settings (step 1 above). The extension already loaded works with it, and **Automatic** uses the app from the next time
the engine starts (after **Release**, or 5 minutes without use).

- **Engine** under **Settings** in the panel: **Automatic** uses the app when it is connected (step 1 above) and the browser otherwise
  (the list shows which it uses now); **PLaMo Translate Desktop** and **In the browser** choose one. The `browser-extension` folder of
  the app's packages can also be loaded without the app, but only the extension's own package tells when a new version is out
  (the app's copy leaves that to the app): without the app, use that one.
- In the browser, choose and download a model under **Settings**: 0.8B or 2B (Q4_K_M; the larger ones do not fit in WebAssembly's memory).
  When PFN publishes a new version of a model you have, it stays usable, and **Settings** says so with the date; **Update** downloads it.
  The extension asks Hugging Face at most once a day; offline, it does nothing and the downloaded models work as before.
  The first download asks you to accept the PLaMo Community License. Models are stored in the browser, separately from the app's:
  in the extension's own storage in the browser profile, not as files the app could share. With the app installed,
  the extension translates with the app's model, and the one in the browser can be deleted under **Settings**.
- **Device**: **Automatic** measures the CPU (WebAssembly) and the GPU (WebGPU) on the first translation and keeps the faster one,
  shown as, for example, **Automatic (GPU)** with the speeds measured. **Measure and choose** below it measures them again.
  With 2B, generation runs at about 48 tokens/s on a Ryzen AI Max+ 395 (Radeon 8060S), 67 on a Radeon RX 9070 XT,
  and 18 on the CPU of a Ryzen 9 9950X: slower than the app, but usable. Reading long texts is slower on the CPU.
  With **CPU** chosen as the device, the number of threads can be set below it.
  Page translation runs four batches of paragraphs at once, dealt in turn so that the page fills from the top; **Translate pages in
  parallel** under **Settings** turns it off, for wording that follows the paragraphs before more closely but slower translation.
  The extension asks for the high-performance GPU, but Chrome and Edge use the GPU Windows assigns them: on a PC whose display
  runs on the integrated GPU, give the browser the discrete GPU under Windows' Settings → System → Display → Graphics.
- As with the app, the model is released after 5 minutes without use, or with **Release**.

## Building from source

Requirements: Rust 1.92 or later, CMake, and a C/C++ compiler.

Linux (Ubuntu or Debian):

```sh
sudo apt install cmake libfontconfig-dev libwayland-dev libxkbcommon-x11-dev libx11-xcb-dev
cargo run -p plamo-translate-desktop --release
```

This development build runs on the CPU, with llama.cpp linked statically.
Packages are built like the Release workflow does: with the size-optimized `dist` profile (fat LTO, stripped), Vulkan, and dynamically loaded backends.
The Vulkan backend also needs `libvulkan-dev glslc spirv-headers`.

```sh
cargo build --profile dist -p plamo-translate-desktop --features engine/vulkan,engine/dynamic-backends
```

On Linux (including WSL2) with an AMD GPU, the ROCm (HIP) backend runs the model on the GPU.
It needs ROCm and its development packages, for example `amdrocm-core-dev10.1-gfx1201 amdrocm-blas-dev10.1` for an RX 9070 XT.
`scripts/rocm.sh` sets up the environment and builds into `target/rocm`:

```sh
scripts/rocm.sh cargo run -p plamo-translate-desktop --release --features rocm
```

Windows needs Visual Studio 2022 with "Desktop development with C++" (MSVC and the Windows SDK) and CMake.
The GPU build also needs the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home#windows):

```powershell
cargo build -p plamo-translate-desktop --release --features engine/vulkan,engine/dynamic-backends
```

With `dynamic-backends`, copy the `ggml-*.dll` modules from `target/release/build/llama-cpp-sys-2-*/out/backends` next to the executable,
or run it with `cargo run`, which finds them in the build directory.

macOS (Apple Silicon) needs the Xcode Command Line Tools and CMake (`brew install cmake`).
There llama.cpp runs on the GPU through Metal, also in the development build above.
`scripts/package-macos.sh` builds the package: an app bundle for macOS 13.3 or later in a disk image.
It needs `cargo-about` (`brew install cargo-about`) for the third-party notices.
The bundle is signed ad hoc, which Gatekeeper accepts only on the Mac that built it, unless `CODESIGN_IDENTITY` names a Developer ID and the app is then notarized.

```sh
scripts/package-macos.sh
```

### Development

- `crates/pfml`: PFML3 prompt builder (the PLaMo prompt format).
- `crates/engine`: llama.cpp backend, model catalog, downloads, long-text splitting. No GUI dependency.
- `crates/appdata`: settings, file locations, and logging, shared by the app and the browser host.
- `crates/app`: the GPUI application.
- `crates/host`: `plamo-translate-host`, the native messaging host for the browser extension.
- `extension/`: the browser extension (Manifest V3).
- `docs/design.md`: the design document.

Two command-line examples run the engine without the GUI:

```sh
cargo run -p engine --release --example translate -- --model path/to/model.gguf --to en "こんにちは"
cargo run -p engine --release --example download -- --list
```

A GGUF path passed as the first argument (or in `PLAMO_MODEL`) overrides the model selected in the app.

### Files and logs

Models (in `models/`, unless another folder is chosen in the Models dialog), the cached model list (`catalog.json`), the last check for a new version (`update.json`), small logs (`app.log`, and `host.log` for the browser extension's host),
and the NPU's compiled graphs (`openvino-cache/`) are kept in:

- Windows: `%LOCALAPPDATA%\plamo-translate-desktop\data`
- Linux: `~/.local/share/plamo-translate-desktop` (`$XDG_DATA_HOME`)
- macOS: `~/Library/Application Support/plamo-translate-desktop`

The log records start-up, detected devices, model loads, downloads, deletions, settings changes, and where long texts were retried or cut, but never translated text.
A log larger than 1 MiB is moved to `app.log.1` at start-up.

An update is prepared in `update` in the app's folder (on macOS, a hidden folder next to the app, `.PLaMo Translate Desktop-update`), which the next start removes.

Settings are in `settings.json`: `%APPDATA%\plamo-translate-desktop\config` on Windows, `~/.config/plamo-translate-desktop` (`$XDG_CONFIG_HOME`) on Linux,
and the data folder above on macOS.

## License

The source code of this app is licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. The PLaMo models are not part of this repository and are covered by the PLaMo Community License.

The packages include third-party software: the app's Rust crates, llama.cpp, Lucide icons, the browser extension's wllama
(built with Emscripten and Dawn), on Windows the Visual C++ runtime, and in the Intel NPU package OpenVINO, oneTBB and the OpenCL loader.
Their licenses are in `THIRD-PARTY-NOTICES.txt` in each package, generated by `scripts/notices.sh`
(the browser extension package has the in-browser engine's only).
