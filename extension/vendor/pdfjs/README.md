# PDF.js

[PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) reads and draws PDFs. The extension's PDF
viewer (`pdf.html`) uses it to draw the pages and to find their text.

From the npm package `pdfjs-dist` 6.4.299
(`sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`):

- `build/pdf.min.mjs` and `build/pdf.worker.min.mjs`
- `cmaps/` (character maps, which CJK PDFs need), `standard_fonts/` (for PDFs that do not embed the
  standard fonts), and `iccs/`
- from `wasm/`: `jbig2.wasm`, `openjpeg.wasm` and `qcms_bg.wasm` (image decoders and color
  management), with their licenses

To update, replace these files with those of a newer package.
