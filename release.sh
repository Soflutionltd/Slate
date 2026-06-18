#!/usr/bin/env bash
# Alto desktop release script
#
# Builds a signed macOS bundle (Apple silicon) and prepares the artifacts that
# `tauri-plugin-updater` expects on GitHub Releases.
#
# Required env:
#   TAURI_SIGNING_PRIVATE_KEY        — content of ~/.alto/alto.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD — empty string for the current key
#
# Outputs (in src-tauri/target/release/bundle/):
#   - macos/Alto.app            (raw bundle, sign + notarize before shipping)
#   - dmg/Alto_VERSION_aarch64.dmg
#   - macos/Alto.app.tar.gz     (updater payload)
#   - macos/Alto.app.tar.gz.sig (minisign signature)
#   - latest.json               (manifest consumed by tauri-plugin-updater)

set -euo pipefail

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ -f "$HOME/.alto/alto.key" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.alto/alto.key")"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  else
    echo "TAURI_SIGNING_PRIVATE_KEY missing and ~/.alto/alto.key not found" >&2
    exit 1
  fi
fi

VERSION="$(grep '^version' src-tauri/tauri.conf.json | head -1 | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
ARCH="aarch64"
echo "Building Alto v${VERSION} (${ARCH})…"

cargo tauri build

BUNDLE_DIR="src-tauri/target/release/bundle"
SIG_FILE="${BUNDLE_DIR}/macos/Alto.app.tar.gz.sig"
TAR_FILE="${BUNDLE_DIR}/macos/Alto.app.tar.gz"

if [[ ! -f "$SIG_FILE" || ! -f "$TAR_FILE" ]]; then
  echo "Updater artifacts missing — check the build output." >&2
  exit 1
fi

PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIG_CONTENT="$(cat "$SIG_FILE")"
DOWNLOAD_URL="https://github.com/Soflution1/sofdocs-desktop/releases/download/v${VERSION}/Alto.app.tar.gz"

cat > "${BUNDLE_DIR}/macos/latest.json" <<EOF
{
  "version": "${VERSION}",
  "notes": "See https://github.com/Soflution1/sofdocs-desktop/releases/tag/v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG_CONTENT}",
      "url": "${DOWNLOAD_URL}"
    }
  }
}
EOF

echo
echo "Done. Artifacts:"
echo "  DMG:        ${BUNDLE_DIR}/dmg/Alto_${VERSION}_${ARCH}.dmg"
echo "  Updater:    ${BUNDLE_DIR}/macos/Alto.app.tar.gz"
echo "  Signature:  ${SIG_FILE}"
echo "  Manifest:   ${BUNDLE_DIR}/macos/latest.json"
echo
echo "Next: create a GitHub release v${VERSION} on Soflution1/sofdocs-desktop"
echo "and upload Alto.app.tar.gz, Alto.app.tar.gz.sig and latest.json."
