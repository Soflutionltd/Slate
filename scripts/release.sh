#!/usr/bin/env bash
# Slate — release one-shot (build signé + auto-update)
#
# Construit un bundle macOS signé universel (Apple silicon + Intel), génère le manifeste
# `latest.json` attendu par tauri-plugin-updater, puis publie la release sur
# GitHub. Les utilisateurs sur une version antérieure reçoivent alors le pop-up
# « Mise à jour disponible ».
#
# Usage :
#   ./scripts/release.sh            # notes tirées de frontend-dist/whats-new.json
#   ./scripts/release.sh "Notes de version ici"
#
# Pré-requis :
#   - Clé de signature updater : ~/.tauri/slate_updater.key (générée via tauri signer)
#   - Identité Developer ID Application dans le trousseau
#   - gh CLI authentifié avec accès en écriture au repo de release
#
# Notarisation (obligatoire) : clé API App Store Connect
# (~/.appstoreconnect/private_keys/AuthKey_<id>.p8) ou, à défaut,
# APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID. Tauri notarise et agrafe le .app
# avant de créer l'archive updater ; sans identifiants, la release est refusée.

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

# ── Identifiants de notarisation ─────────────────────────────────────────
ASC_KEY_ID="${APPLE_API_KEY:-77ZLGAGK7W}"
ASC_KEY_PATH="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
if [[ -z "${APPLE_ID:-}" && -f "$ASC_KEY_PATH" ]]; then
  export APPLE_API_KEY="$ASC_KEY_ID"
  export APPLE_API_ISSUER="${APPLE_API_ISSUER:-ab5aeb0f-f6b3-43e8-bf3f-5ed0dc325471}"
  export APPLE_API_KEY_PATH="$ASC_KEY_PATH"
fi
if [[ -z "${APPLE_API_KEY_PATH:-}" && ( -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ) ]]; then
  echo "ERREUR : aucun identifiant de notarisation ($ASC_KEY_PATH absent, APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID non définis)." >&2
  exit 1
fi

VERSION="$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
TAG="v${VERSION}"
ARCH="universal"
TARGET_TRIPLE="universal-apple-darwin"
echo "▶ Release Slate ${TAG} (${ARCH}) → ${REPO}"

# Cache Rust partagé (sccache si installé) — même artefact signé, recompil plus vite.
# shellcheck source=scripts/release-env.sh
source "$SCRIPT_DIR/release-env.sh"

# Refuser une release si le module frontend contient une erreur de syntaxe.
node --check src-tauri/frontend-dist/app.js

# Nouveautés : chaque version publiée a son entrée et ses médias dans
# whats-new.json. La fenêtre « Nouveautés » et les notes de l'updater en
# viennent toutes les deux.
WHATS_NEW_NOTES="$(node - "$VERSION" <<'JS'
const fs = require('fs');
const path = require('path');
const version = process.argv[2];
const dir = 'src-tauri/frontend-dist';
const { releases } = JSON.parse(fs.readFileSync(path.join(dir, 'whats-new.json'), 'utf8'));
const release = releases.find((entry) => entry.version === version);
if (!release) {
  console.error(`ERREUR : aucune entrée ${version} dans ${dir}/whats-new.json.`);
  process.exit(1);
}
for (const file of Object.values(release.media || {})) {
  if (!fs.existsSync(path.join(dir, file))) {
    console.error(`ERREUR : média des Nouveautés manquant : ${dir}/${file}.`);
    process.exit(1);
  }
}
const lines = [release.title.fr, ...release.changes.map((change) => `${change.area.fr} : ${change.text.fr}`)];
process.stdout.write(lines.join('\n'));
JS
)"

# Le binding PDFium épinglé utilise FPDFText_SetPositions (API 7881+).
# Refuser une release avec une ancienne dylib évite un échec au lancement.
bash "$SCRIPT_DIR/ensure-pdfium.sh"
PDFIUM_LIB="src-tauri/libpdfium.dylib"
for pdfium_arch in arm64 x86_64; do
  if ! nm -gU -arch "$pdfium_arch" "$PDFIUM_LIB" 2>/dev/null | rg '_FPDFText_SetPositions$' >/dev/null; then
    echo "ERREUR : $PDFIUM_LIB ($pdfium_arch) doit exporter FPDFText_SetPositions (PDFium 7881+)." >&2
    exit 1
  fi
done

# ── Build signé + artefacts updater ──────────────────────────────────────
# 1) Sidecars alto-mcp + slate-ocr pour les deux architectures (skip si inchangés)
# 2) cargo tauri build universel + bundle signé
export SLATE_TARGET_TRIPLE="$TARGET_TRIPLE"
bash "$SCRIPT_DIR/ensure-alto-mcp.sh"
bash "$SCRIPT_DIR/ensure-ocr-helper.sh"

# --bundles app : le .app (+ .app.tar.gz/.sig pour l'updater). Le DMG Tauri ouvre
# une fenêtre Finder pendant le build : Slate.dmg est créé plus bas avec hdiutil.
# Lancé depuis src-tauri : depuis apps/desktop, la CLI prend pour racine le premier
# package.json trouvé en descendant (ex. media/whats-new-*/) et y exécute
# beforeBuildCommand.
(cd src-tauri && cargo tauri build --target "$TARGET_TRIPLE" --bundles app)

BUNDLE_DIR="src-tauri/target/${TARGET_TRIPLE}/release/bundle"
TAR_FILE="${BUNDLE_DIR}/macos/Slate.app.tar.gz"
SIG_FILE="${TAR_FILE}.sig"
# Nom sans version : /releases/latest/download/Slate.dmg reste un lien fixe.
DMG_FILE="${BUNDLE_DIR}/dmg/Slate.dmg"

if [[ ! -f "$TAR_FILE" || ! -f "$SIG_FILE" ]]; then
  echo "ERREUR : artefacts updater manquants (createUpdaterArtifacts activé ?)." >&2
  echo "Attendu : $TAR_FILE (+ .sig)" >&2
  exit 1
fi

# ── Notarisation : vérification du .app, puis DMG éventuel ───────────────
# Le .app a été notarisé et agrafé par Tauri : Gatekeeper doit l'accepter
# hors ligne, sinon on ne publie pas.
APP_BUNDLE="${BUNDLE_DIR}/macos/Slate.app"
# Chaque exécutable et PDFium doivent contenir les deux architectures : une
# seule tranche manquante et l'app ne s'ouvre pas sur les Mac concernés.
for slice_file in "$APP_BUNDLE"/Contents/MacOS/* "$APP_BUNDLE/Contents/Resources/libpdfium.dylib"; do
  slice_archs="$(lipo -archs "$slice_file")"
  if [[ "$slice_archs" != *arm64* || "$slice_archs" != *x86_64* ]]; then
    echo "ERREUR : $slice_file n'est pas universel ($slice_archs)." >&2
    exit 1
  fi
done
echo "   Slate.app universel (arm64 + x86_64)."
if ! spctl -a -vv -t exec "$APP_BUNDLE" 2>&1 | rg -q 'source=Notarized Developer ID'; then
  echo "ERREUR : $APP_BUNDLE n'est pas notarisé (spctl)." >&2
  spctl -a -vv -t exec "$APP_BUNDLE" >&2 || true
  exit 1
fi
echo "   Slate.app notarisé (Gatekeeper OK)."

# ── Slate.dmg : installeur des nouveaux utilisateurs ─────────────────────
echo "▶ Création de Slate.dmg…"
DMG_STAGING="$(mktemp -d)"
ditto "$APP_BUNDLE" "$DMG_STAGING/Slate.app"
ln -s /Applications "$DMG_STAGING/Applications"
mkdir -p "$(dirname "$DMG_FILE")"
hdiutil create -volname "Slate" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_FILE" >/dev/null
rm -rf "$DMG_STAGING"
codesign --force --timestamp --sign "Developer ID Application: Soflution ltd (TB8CC687M3)" "$DMG_FILE"
echo "▶ Notarisation du DMG…"
if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
  xcrun notarytool submit "$DMG_FILE" \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait
else
  xcrun notarytool submit "$DMG_FILE" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
    --wait
fi
xcrun stapler staple "$DMG_FILE"
if ! spctl -a -vv -t open --context context:primary-signature "$DMG_FILE" 2>&1 | rg -q 'source=Notarized Developer ID'; then
  echo "ERREUR : $DMG_FILE n'est pas notarisé (spctl)." >&2
  exit 1
fi
echo "   Slate.dmg notarisé (Gatekeeper OK)."

# ── Manifeste latest.json ────────────────────────────────────────────────
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIG_CONTENT="$(cat "$SIG_FILE")"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/Slate.app.tar.gz"
# NOTES (une seule ligne) est injecté dans le JSON du manifeste updater ;
# RELEASE_NOTES (markdown multi-ligne) sert uniquement à la page GitHub.
[[ -z "$NOTES" ]] && NOTES="$WHATS_NEW_NOTES"

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
DMG_URL="https://github.com/${REPO}/releases/download/${TAG}/Slate.dmg"
RELEASE_NOTES="## ⬇️ Téléchargement direct

**macOS (Apple Silicon et Intel)** : [**Télécharger Slate ${VERSION}**](${DMG_URL}) — \`Slate.dmg\`. Ouvrez-le puis glissez **Slate** dans *Applications*.

**Windows (x64)** : [**Télécharger Slate ${VERSION}**](${WIN_URL}) — installeur \`.exe\`.

_Les fichiers \`Slate.app.tar.gz\`, \`.sig\` et \`latest.json\` servent uniquement aux mises à jour automatiques — inutile de les télécharger._

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
    },
    "darwin-x86_64": {
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

# Conserver windows-x86_64 / linux-x86_64 déjà publiés sur cette tag
# (CI les ajoute après le build Mac).
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  MERGE_DIR="$(mktemp -d)"
  if gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$MERGE_DIR" >/dev/null 2>&1 \
    && [[ -f "$MERGE_DIR/latest.json" ]]; then
    python3 - "$MANIFEST" "$MERGE_DIR/latest.json" <<'PY'
import json, sys
from pathlib import Path
ours = json.loads(Path(sys.argv[1]).read_text())
try:
    theirs = json.loads(Path(sys.argv[2]).read_text())
except Exception:
    theirs = {}
platforms = {}
if isinstance(theirs.get("platforms"), dict):
    platforms.update(theirs["platforms"])
if isinstance(ours.get("platforms"), dict):
    platforms.update(ours["platforms"])
ours["platforms"] = platforms
Path(sys.argv[1]).write_text(json.dumps(ours, indent=2) + "\n")
PY
  fi
  rm -rf "$MERGE_DIR"
fi

# ── Publication GitHub ───────────────────────────────────────────────────
echo "▶ Publication de la release ${TAG}…"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$TAR_FILE" "$SIG_FILE" "$MANIFEST" ${DMG_FILE:+"$DMG_FILE"} \
    --repo "$REPO" --clobber
else
  TARGET_SHA="$(gh api "repos/${REPO}/commits/main" --jq .sha)"
  gh release create "$TAG" "$TAR_FILE" "$SIG_FILE" "$MANIFEST" ${DMG_FILE:+"$DMG_FILE"} \
    --repo "$REPO" --title "Slate ${VERSION}" --notes "$RELEASE_NOTES" --latest \
    --target "$TARGET_SHA"
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
