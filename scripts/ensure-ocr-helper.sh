#!/usr/bin/env bash
# Compile le sidecar OCR Apple Vision (`slate-ocr`) embarqué dans Slate.app.
# macOS uniquement : Windows et Linux ont leur propre chemin OCR. Le binaire
# est signé/notarisé avec l'app par le bundler Tauri (externalBin) — le client
# n'installe rien (ni Xcode Command Line Tools, ni Tesseract).
# Cible : même règle que ensure-alto-mcp.sh (universal-apple-darwin = fusion lipo).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/src-tauri"

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
TARGET_TRIPLE="${SLATE_TARGET_TRIPLE:-${TAURI_ENV_TARGET_TRIPLE:-$HOST_TRIPLE}}"
SOURCE="ocr-helper/main.swift"
# Aligné sur bundle.macOS.minimumSystemVersion (tauri.conf.json).
MIN_MACOS="11.0"

if [[ "$TARGET_TRIPLE" == "universal-apple-darwin" ]]; then
	ARCH_TRIPLES=(aarch64-apple-darwin x86_64-apple-darwin)
else
	ARCH_TRIPLES=("$TARGET_TRIPLE")
fi

mkdir -p binaries

file_mtime() {
	stat -f '%m' "$1"
}

for triple in "${ARCH_TRIPLES[@]}"; do
	case "$triple" in
		aarch64-apple-darwin) swift_target="arm64-apple-macos${MIN_MACOS}" ;;
		x86_64-apple-darwin) swift_target="x86_64-apple-macos${MIN_MACOS}" ;;
		*)
			echo "ensure-ocr-helper: triple macOS inconnu : $triple" >&2
			exit 1
			;;
	esac
	sidecar="binaries/slate-ocr-${triple}"
	if [[ -s "$sidecar" ]] && (( $(file_mtime "$SOURCE") <= $(file_mtime "$sidecar") )); then
		echo "▶ slate-ocr ${triple} à jour — skip swiftc"
		continue
	fi
	echo "▶ Build slate-ocr ${triple} (Apple Vision)…"
	xcrun swiftc -O -target "$swift_target" -o "$sidecar" "$SOURCE"
	chmod +x "$sidecar"
done

if [[ "$TARGET_TRIPLE" == "universal-apple-darwin" ]]; then
	lipo -create -output binaries/slate-ocr-universal-apple-darwin \
		binaries/slate-ocr-aarch64-apple-darwin binaries/slate-ocr-x86_64-apple-darwin
fi
