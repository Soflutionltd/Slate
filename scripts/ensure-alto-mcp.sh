#!/usr/bin/env bash
# Ne recompile alto-mcp que si les sources pertinentes ont changé depuis le
# dernier binaire release. Même sidecar embarqué, moins d'attente quand seul
# le frontend ou des parties non liées au MCP ont bougé.
#
# Cible : SLATE_TARGET_TRIPLE, sinon TAURI_ENV_TARGET_TRIPLE (posé par
# `cargo tauri build --target …`), sinon la machine. `universal-apple-darwin` :
# un binaire par architecture (build.rs Tauri les exige) + leur fusion lipo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/src-tauri"

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
TARGET_TRIPLE="${SLATE_TARGET_TRIPLE:-${TAURI_ENV_TARGET_TRIPLE:-$HOST_TRIPLE}}"
if [[ "$TARGET_TRIPLE" == "universal-apple-darwin" ]]; then
	ARCH_TRIPLES=(aarch64-apple-darwin x86_64-apple-darwin)
else
	ARCH_TRIPLES=("$TARGET_TRIPLE")
fi

mkdir -p binaries
# Placeholders exigés par build.rs Tauri avant la résolution externalBin
# (macOS : slate-ocr aussi, compilé ensuite par ensure-ocr-helper.sh).
for triple in "${ARCH_TRIPLES[@]}"; do
	touch "binaries/alto-mcp-${triple}"
	if [[ "$(uname -s)" == "Darwin" && ! -e "binaries/slate-ocr-${triple}" ]]; then
		: > "binaries/slate-ocr-${triple}"
	fi
done

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

src_mtime="$(source_newest_mtime)"
for triple in "${ARCH_TRIPLES[@]}"; do
	if [[ "$triple" == "$HOST_TRIPLE" ]]; then
		binary="target/release/alto-mcp"
		target_args=()
	else
		binary="target/${triple}/release/alto-mcp"
		target_args=(--target "$triple")
	fi
	if [[ -f "$binary" ]] && (( src_mtime <= $(file_mtime "$binary") )); then
		echo "▶ alto-mcp ${triple} à jour — skip cargo build"
	else
		echo "▶ Build alto-mcp ${triple}…"
		cargo build --release --bin alto-mcp ${target_args[@]+"${target_args[@]}"}
	fi
	cp -f "$binary" "binaries/alto-mcp-${triple}"
done

if [[ "$TARGET_TRIPLE" == "universal-apple-darwin" ]]; then
	lipo -create -output binaries/alto-mcp-universal-apple-darwin \
		binaries/alto-mcp-aarch64-apple-darwin binaries/alto-mcp-x86_64-apple-darwin
	# Le bundler copie chaque [[bin]] depuis target/universal-apple-darwin/release,
	# mais Tauri ne fusionne que le binaire principal.
	mkdir -p target/universal-apple-darwin/release
	cp -f binaries/alto-mcp-universal-apple-darwin target/universal-apple-darwin/release/alto-mcp
fi
