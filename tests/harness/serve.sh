#!/usr/bin/env bash
# Lance le frontend desktop dans un navigateur avec le vrai moteur PDFium :
# pont Rust sur 127.0.0.1:18766, fichiers statiques sur 127.0.0.1:18767.
# Ouvrir http://127.0.0.1:18767/index.html, puis window.__harness.openFixture('wire.pdf').
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(cd "$here/../.." && pwd)"
frontend="$desktop/src-tauri/frontend-dist"
root="${HARNESS_ROOT:-/tmp/slate-native-harness}"

rm -rf "$root"
mkdir -p "$root/fixtures"
for entry in "$frontend"/*; do
	name="$(basename "$entry")"
	[[ "$name" == "index.html" ]] || ln -s "$entry" "$root/$name"
done
ln -s "$here/tauri-shim.js" "$root/tauri-shim.js"
ln -s "$here/harness.js" "$root/harness.js"
python3 "$here/make-fixtures.py" "$root/fixtures"
sed 's#<script type="module" src="./app.js"></script>#<script src="./tauri-shim.js"></script>\n\t\t<script src="./harness.js"></script>\n\t\t<script type="module" src="./app.js"></script>#' \
	"$frontend/index.html" > "$root/index.html"
grep -q 'tauri-shim.js' "$root/index.html" || { echo "index.html : point d'insertion introuvable" >&2; exit 1; }

cargo build --quiet --example harness_bridge --manifest-path "$desktop/crates/pdf-engine/Cargo.toml"
export ALTO_PDFIUM_DIR="$desktop/src-tauri"
"$desktop/crates/pdf-engine/target/debug/examples/harness_bridge" 18766 &
bridge=$!
trap 'kill $bridge 2>/dev/null' EXIT
cd "$root" && python3 -m http.server 18767 --bind 127.0.0.1
