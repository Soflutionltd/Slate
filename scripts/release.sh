#!/usr/bin/env bash
# Slate — release one-shot (build signé + auto-update)
#
# Construit un bundle macOS signé (Apple silicon), génère le manifeste
# `latest.json` attendu par tauri-plugin-updater, puis publie la release sur
# GitHub. Les utilisateurs sur une version antérieure reçoivent alors le pop-up
# « Mise à jour disponible ».
#
# Usage :
#   ./scripts/release.sh            # notes par défaut
#   ./scripts/release.sh "Notes de version ici"
#
# Pré-requis :
#   - Clé de signature updater : ~/.tauri/slate_updater.key (générée via tauri signer)
#   - Identité Developer ID Application dans le trousseau
#   - gh CLI authentifié avec accès en écriture au repo de release
#
# Notarisation (optionnelle) : si APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID sont
# définis, le .app et le .dmg sont notarisés avant publication.

set -euo pipefail

REPO="Soflutionltd/Slate"
KEY_PATH="$HOME/.tauri/slate_updater.key"
NOTES="${1:-}"

# Se placer à la racine du projet desktop (dossier parent de scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── Clé de signature ────────────────────────────────────────────────────
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ -f "$KEY_PATH" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  else
    echo "ERREUR : clé de signature absente ($KEY_PATH) et TAURI_SIGNING_PRIVATE_KEY non défini." >&2
    exit 1
  fi
fi

VERSION="$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
TAG="v${VERSION}"
ARCH="aarch64"
echo "▶ Release Slate ${TAG} (${ARCH}) → ${REPO}"

# ── Build signé + artefacts updater ──────────────────────────────────────
cargo tauri build

BUNDLE_DIR="src-tauri/target/release/bundle"
TAR_FILE="${BUNDLE_DIR}/macos/Slate.app.tar.gz"
SIG_FILE="${TAR_FILE}.sig"
DMG_FILE="${BUNDLE_DIR}/dmg/Slate_${VERSION}_${ARCH}.dmg"

if [[ ! -f "$TAR_FILE" || ! -f "$SIG_FILE" ]]; then
  echo "ERREUR : artefacts updater manquants (createUpdaterArtifacts activé ?)." >&2
  echo "Attendu : $TAR_FILE (+ .sig)" >&2
  exit 1
fi

# ── Notarisation optionnelle ─────────────────────────────────────────────
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" && -f "$DMG_FILE" ]]; then
  echo "▶ Notarisation du DMG…"
  xcrun notarytool submit "$DMG_FILE" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG_FILE" || true
else
  echo "⚠ Notarisation ignorée (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID non définis)."
fi

# ── Manifeste latest.json ────────────────────────────────────────────────
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIG_CONTENT="$(cat "$SIG_FILE")"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/Slate.app.tar.gz"
[[ -z "$NOTES" ]] && NOTES="Slate ${VERSION} — voir https://github.com/${REPO}/releases/tag/${TAG}"
MANIFEST="${BUNDLE_DIR}/latest.json"

cat > "$MANIFEST" <<EOF
{
  "version": "${VERSION}",
  "notes": "${NOTES}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG_CONTENT}",
      "url": "${DOWNLOAD_URL}"
    }
  }
}
EOF

# ── Publication GitHub ───────────────────────────────────────────────────
echo "▶ Publication de la release ${TAG}…"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$TAR_FILE" "$SIG_FILE" "$MANIFEST" ${DMG_FILE:+"$DMG_FILE"} \
    --repo "$REPO" --clobber
else
  gh release create "$TAG" "$TAR_FILE" "$SIG_FILE" "$MANIFEST" ${DMG_FILE:+"$DMG_FILE"} \
    --repo "$REPO" --title "Slate ${VERSION}" --notes "$NOTES" --latest
fi

echo
echo "✅ Release ${TAG} publiée sur ${REPO}."
echo "   Les utilisateurs en version antérieure (≥ celle qui embarque l'updater)"
echo "   verront le pop-up de mise à jour au prochain lancement."
