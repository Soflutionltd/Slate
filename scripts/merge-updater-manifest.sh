#!/usr/bin/env bash
# Fusionne une plateforme (windows-x86_64 / linux-x86_64 / darwin-aarch64)
# dans latest.json de la release GitHub, sans écraser les autres OS.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-Soflutionltd/Slate}"
TAG="${1:-}"
PLATFORM="${2:-}"
SIG_FILE="${3:-}"
URL="${4:-}"
VERSION="${5:-}"

if [[ -z "$TAG" || -z "$PLATFORM" || -z "$SIG_FILE" || -z "$URL" ]]; then
	echo "Usage: merge-updater-manifest.sh <tag> <platform> <sig-file> <url> [version]" >&2
	exit 1
fi
if [[ ! -f "$SIG_FILE" ]]; then
	echo "ERREUR : signature introuvable ($SIG_FILE)" >&2
	exit 1
fi
if [[ -z "$VERSION" ]]; then
	VERSION="${TAG#v}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
EXISTING="$TMP/latest.json"

if ! gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$TMP" >/dev/null 2>&1; then
	printf '%s\n' '{"version":"","notes":"","pub_date":"","platforms":{}}' > "$EXISTING"
fi

if command -v python3 >/dev/null 2>&1; then
	PY=python3
else
	PY=python
fi
"$PY" - "$EXISTING" "$SIG_FILE" "$PLATFORM" "$URL" "$VERSION" <<'PY'
import json, sys, datetime
from pathlib import Path

manifest_path, sig_path, platform, url, version = sys.argv[1:6]
try:
    manifest = json.loads(Path(manifest_path).read_text())
except Exception:
    manifest = {}
if not isinstance(manifest, dict):
    manifest = {}
sig = Path(sig_path).read_text().strip()
if not sig:
    raise SystemExit(f"signature vide: {sig_path}")
manifest["version"] = version or manifest.get("version") or ""
if not manifest.get("notes"):
    manifest["notes"] = f"Slate {manifest['version']}"
if not manifest.get("pub_date"):
    manifest["pub_date"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
platforms = manifest.get("platforms")
if not isinstance(platforms, dict):
    platforms = {}
platforms[platform] = {"signature": sig, "url": url}
manifest["platforms"] = platforms
Path(manifest_path).write_text(json.dumps(manifest, indent=2) + "\n")
PY

gh release upload "$TAG" "$EXISTING" --repo "$REPO" --clobber
echo "latest.json ← ${PLATFORM} (${TAG})"
