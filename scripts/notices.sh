#!/bin/sh
# Writes THIRD-PARTY-NOTICES.txt for a package: the licenses of the Rust crates (cargo-about,
# configured by about.toml and about.hbs) followed by the components cargo-about cannot see.
#
# usage: scripts/notices.sh windows|linux|macos|extension OUTPUT
#   extension: the browser extension alone, which has no Rust code; its notices are the
#   in-browser engine's and the PDF viewer's.
set -eu
platform=$1
output=$2
cd "$(dirname "$0")/.."

# PDF.js, which the browser extension's PDF viewer uses: its licenses as vendored with it, so
# that they follow the files when PDF.js is updated.
pdfjs() {
    dir=extension/vendor/pdfjs
    echo "PDF.js (browser extension)"
    echo "--------------------------"
    echo
    echo "The browser extension's PDF viewer draws PDFs with PDF.js (vendor/pdfjs). It comes with"
    echo "character maps, fonts and color profiles for PDFs that do not carry their own, and with"
    echo "image decoders compiled to WebAssembly, under these licenses."
    pdfjs_license "PDF.js (https://github.com/mozilla/pdf.js):" LICENSE
    pdfjs_license "Character maps (cmaps), from Adobe:" cmaps/LICENSE
    pdfjs_license "Standard fonts (standard_fonts): the Foxit fonts, from PDFium:" standard_fonts/LICENSE_FOXIT
    pdfjs_license "Standard fonts (standard_fonts): the Liberation fonts:" standard_fonts/LICENSE_LIBERATION
    pdfjs_license "Color profiles (iccs):" iccs/LICENSE
    pdfjs_license "JBIG2 decoder (wasm/jbig2.wasm): PDF.js's build:" wasm/LICENSE_PDFJS_JBIG2
    pdfjs_license "JBIG2 decoder (wasm/jbig2.wasm): the decoder, from PDFium:" wasm/LICENSE_JBIG2
    pdfjs_license "JPEG 2000 decoder (wasm/openjpeg.wasm): PDF.js's build:" wasm/LICENSE_PDFJS_OPENJPEG
    pdfjs_license "JPEG 2000 decoder (wasm/openjpeg.wasm): OpenJPEG:" wasm/LICENSE_OPENJPEG
    pdfjs_license "Color management (wasm/qcms_bg.wasm): PDF.js's build:" wasm/LICENSE_PDFJS_QCMS
    pdfjs_license "Color management (wasm/qcms_bg.wasm): qcms:" wasm/LICENSE_QCMS
    # Every license file vendored must be named above.
    listed=$(grep -c '^    pdfjs_license ' "$0")
    found=$(find "$dir" -name 'LICENSE*' | wc -l)
    if [ "$listed" -ne "$found" ]; then
        echo "scripts/notices.sh lists $listed licenses of PDF.js, $dir has $found" >&2
        exit 1
    fi
}
pdfjs_license() {
    echo
    echo "$1"
    echo
    cat "extension/vendor/pdfjs/$2"
}

if [ "$platform" = extension ]; then
    {
        echo "Third-party components"
        echo "======================"
        echo
        cat licenses/llama.cpp.txt
        echo
        cat licenses/wllama.txt
        echo
        pdfjs
    } > "$output"
    exit 0
fi
# about.toml lists the Windows and Linux targets; the macOS package has its own crate set.
set --
if [ "$platform" = macos ]; then
    set -- --target aarch64-apple-darwin
fi
{
    cargo about generate --locked "$@" about.hbs
    echo "Other components"
    echo "================"
    echo
    cat licenses/llama.cpp.txt
    echo
    cat licenses/wllama.txt
    echo
    pdfjs
    echo
    cat licenses/lucide.txt
    if [ "$platform" = windows ]; then
        echo
        cat licenses/msvc-runtime.txt
    fi
} > "$output"
