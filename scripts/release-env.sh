#!/usr/bin/env bash
# Variables d'environnement partagées par release.sh et les builds Tauri locaux.
# Même binaire final ; compilation plus rapide grâce au cache Rust partagé.

if command -v sccache >/dev/null 2>&1; then
	export RUSTC_WRAPPER=sccache
	export SCCACHE_CACHE_SIZE="${SCCACHE_CACHE_SIZE:-10G}"
	echo "▶ sccache actif ($(sccache -s 2>/dev/null | sed -n 's/^Cache size.*/&/p' | head -1 || echo 'stats indisponibles'))"
fi

export CARGO_TERM_COLOR=always
