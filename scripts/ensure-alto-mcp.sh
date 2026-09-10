#!/usr/bin/env bash
# Ne recompile alto-mcp que si les sources pertinentes ont changé depuis le
# dernier binaire release. Même sidecar embarqué, moins d'attente quand seul
# le frontend ou des parties non liées au MCP ont bougé.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/src-tauri"

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
BINARY="target/release/alto-mcp"
SIDECAR="binaries/alto-mcp-${HOST_TRIPLE}"

mkdir -p binaries
# Placeholder exigé par build.rs Tauri avant la résolution externalBin.
touch "$SIDECAR"

file_mtime() {
	if stat -f '%m' "$1" >/dev/null 2>&1; then
		stat -f '%m' "$1"
	else
		stat -c '%Y' "$1"
	fi
}

source_newest_mtime() {
	local max=0 m
	while IFS= read -r -d '' file; do
		m="$(file_mtime "$file")"
		if (( m > max )); then
			max=$m
		fi
	done < <(
		find src -name '*.rs' -print0
		find ../crates/pdf-engine/src -name '*.rs' -print0 2>/dev/null || true
		printf '%s\0' Cargo.toml ../crates/pdf-engine/Cargo.toml
	)
	echo "$max"
}

if [[ -f "$BINARY" ]]; then
	src_mtime="$(source_newest_mtime)"
	bin_mtime="$(file_mtime "$BINARY")"
	if (( src_mtime <= bin_mtime )); then
		cp -f "$BINARY" "$SIDECAR"
		echo "▶ alto-mcp à jour — skip cargo build"
		exit 0
	fi
fi

echo "▶ Build alto-mcp…"
cargo build --release --bin alto-mcp
cp -f "$BINARY" "$SIDECAR"
