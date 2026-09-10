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

# Par défaut on NE construit PAS le DMG : sa création monte le disque et ouvre une
# fenêtre Finder « glisser dans Applications » (inutile pour une mise à jour, qui
# passe par le paquet .app.tar.gz signé). Passer --dmg pour générer un installeur
# (utile seulement pour les NOUVEAUX utilisateurs qui téléchargent à la main).
BUILD_DMG=0
if [[ "${1:-}" == "--dmg" ]]; then
  BUILD_DMG=1
  shift
fi
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

# Cache Rust partagé (sccache si installé) — même artefact signé, recompil plus vite.
# shellcheck source=scripts/release-env.sh
source "$SCRIPT_DIR/release-env.sh"

# Refuser une release si le module frontend contient une erreur de syntaxe.
node --check src-tauri/frontend-dist/app.js

# Le binding PDFium épinglé utilise FPDFText_SetPositions (API 7881+).
# Refuser une release avec une ancienne dylib évite un échec au lancement.
PDFIUM_LIB="src-tauri/libpdfium.dylib"
if [[ ! -f "$PDFIUM_LIB" ]] || ! nm -gU "$PDFIUM_LIB" | rg '_FPDFText_SetPositions$' >/dev/null; then
  echo "ERREUR : $PDFIUM_LIB doit exporter FPDFText_SetPositions (PDFium 7881+)." >&2
  exit 1
fi

# ── Build signé + artefacts updater ──────────────────────────────────────
# 1) Sidecar alto-mcp (skip si inchangé)
# 2) cargo tauri build + bundle signé
bash "$SCRIPT_DIR/ensure-alto-mcp.sh"

# --bundles app : on ne produit que le .app (+ .app.tar.gz/.sig pour l'updater),
# pas de DMG → aucune fenêtre Finder qui s'ouvre. Avec --dmg on génère aussi le DMG.
if [[ "$BUILD_DMG" -eq 1 ]]; then
	cargo tauri build
else
	cargo tauri build --bundles app
fi

BUNDLE_DIR="src-tauri/target/release/bundle"
TAR_FILE="${BUNDLE_DIR}/macos/Slate.app.tar.gz"
SIG_FILE="${TAR_FILE}.sig"
DMG_FILE="${BUNDLE_DIR}/dmg/Slate_${VERSION}_${ARCH}.dmg"
[[ "$BUILD_DMG" -eq 1 && -f "$DMG_FILE" ]] || DMG_FILE=""

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
# NOTES (une seule ligne) est injecté dans le JSON du manifeste updater ;
# RELEASE_NOTES (markdown multi-ligne) sert uniquement à la page GitHub.
[[ -z "$NOTES" ]] && NOTES="Slate ${VERSION} — voir https://github.com/${REPO}/releases/tag/${TAG}"

# La valeur est injectée dans une chaîne JSON : un saut de ligne ou un guillemet
# non échappé produit un latest.json invalide, que l'updater rejette en silence
# (aucun pop-up de mise à jour côté utilisateurs).
json_string_escape() {
	local value="$1"
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	value="${value//$'\r'/}"
	value="${value//$'\t'/ }"
	value="${value//$'\n'/ · }"
	printf '%s' "$value"
}
MANIFEST_NOTES="$(json_string_escape "$NOTES")"
WIN_URL="https://github.com/${REPO}/releases/download/${TAG}/Slate-windows-x64-setup.exe"
RELEASE_NOTES="## ⬇️ Téléchargement direct

**macOS (Apple Silicon)** : [**Télécharger Slate ${VERSION}**](${DOWNLOAD_URL}) — archive \`.app.tar.gz\`. Double-cliquez puis glissez **Slate.app** dans *Applications*.

**Windows (x64)** : [**Télécharger Slate ${VERSION}**](${WIN_URL}) — installeur \`.exe\`. Ne téléchargez pas \`Slate.app.tar.gz\` (c’est macOS).

_Les fichiers \`.sig\` et \`latest.json\` servent uniquement aux mises à jour automatiques — inutile de les télécharger._

---

${NOTES}"
MANIFEST="${BUNDLE_DIR}/latest.json"

cat > "$MANIFEST" <<EOF
{
  "version": "${VERSION}",
  "notes": "${MANIFEST_NOTES}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG_CONTENT}",
      "url": "${DOWNLOAD_URL}"
    }
  }
}
EOF

# Un manifeste illisible casse la mise à jour sans le moindre message : on refuse
# de publier avant de l'avoir validé.
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MANIFEST" || {
  echo "ERREUR : $MANIFEST n'est pas un JSON valide." >&2
  exit 1
}

# ── Publication GitHub ───────────────────────────────────────────────────
echo "▶ Publication de la release ${TAG}…"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$TAR_FILE" "$SIG_FILE" "$MANIFEST" ${DMG_FILE:+"$DMG_FILE"} \
    --repo "$REPO" --clobber
else
  gh release create "$TAG" "$TAR_FILE" "$SIG_FILE" "$MANIFEST" ${DMG_FILE:+"$DMG_FILE"} \
    --repo "$REPO" --title "Slate ${VERSION}" --notes "$RELEASE_NOTES" --latest
fi

# GitHub peut laisser /releases/latest/download/latest.json pointer sur
# l'avant-dernière tag (CDN). L'updater ne propose alors rien.
echo "▶ Vérification du pointeur /releases/latest → ${TAG}…"
gh release edit "$TAG" --repo "$REPO" --latest >/dev/null
LATEST_OK=0
for _try in 1 2 3 4 5 6 7 8 9 10; do
  LATEST_LOC="$(curl -fsI "https://github.com/${REPO}/releases/latest/download/latest.json?ts=$(date +%s%3N)" \
    | awk 'tolower($1)=="location:" {print $2; exit}' | tr -d '\r')"
  if [[ "$LATEST_LOC" == *"/download/${TAG}/"* ]]; then
    LATEST_OK=1
    break
  fi
  echo "   encore ${LATEST_LOC:-inconnu} — retry ${_try}"
  gh release edit "$TAG" --repo "$REPO" --latest >/dev/null || true
  sleep 2
done
if [[ "$LATEST_OK" -ne 1 ]]; then
  echo "ERREUR : /releases/latest/download/latest.json ne pointe pas sur ${TAG}." >&2
  echo "   Dernier Location: ${LATEST_LOC:-aucun}" >&2
  exit 1
fi
echo "   latest.json → ${TAG}"

echo
echo "✅ Release ${TAG} publiée sur ${REPO}."
echo "   Les utilisateurs en version antérieure (≥ celle qui embarque l'updater)"
echo "   verront le pop-up de mise à jour au prochain lancement."
