#!/usr/bin/env bash
# Installe la PDFium UNIVERSELLE (Apple silicon + Intel) embarquée dans Slate.app
# (src-tauri/libpdfium.dylib, ignorée par git). Même version que les builds
# Windows/Linux (PDFIUM_TAG de .github/workflows/build-desktop.yml).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/src-tauri"

PDFIUM_TAG="chromium/7891"
ARCHIVE_SHA256="cedb51df1f2aa7e6ac33d1f7f4d0a4abb40a848310308b1a41224e6a6834e6d1"
LIB="libpdfium.dylib"
SIGNING_IDENTITY="Developer ID Application: Soflution ltd (TB8CC687M3)"

if [[ -f "$LIB" ]]; then
	archs="$(lipo -archs "$LIB")"
	if [[ "$archs" == *x86_64* && "$archs" == *arm64* ]]; then
		echo "▶ PDFium universelle présente — skip"
		exit 0
	fi
fi

echo "▶ PDFium ${PDFIUM_TAG} universelle…"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -L --fail --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 30 --max-time 300 \
	-o "$WORK/pdfium.tgz" \
	"https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-mac-univ.tgz"
echo "${ARCHIVE_SHA256}  $WORK/pdfium.tgz" | shasum -a 256 -c - >/dev/null
tar -xzf "$WORK/pdfium.tgz" -C "$WORK"
cp -f "$WORK/lib/libpdfium.dylib" "$LIB"
codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$LIB"
echo "   $(lipo -archs "$LIB") — signée"
