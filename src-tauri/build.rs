use std::fs;
use std::path::Path;

fn main() {
    // Le frontend (`frontend-dist`) est embarqué par `generate_context!()` au moment
    // de COMPILER `main.rs`. Cargo n'a aucun moyen de savoir que `main.rs` dépend de
    // ces fichiers : un changement de `frontend-dist` ne déclenche donc PAS de rebuild,
    // et le binaire embarque un frontend périmé (bug récurrent de déploiement).
    //
    // Parade : on écrit une empreinte du frontend dans OUT_DIR (incluse par `main.rs`
    // via `include_str!`) ET on émet `rerun-if-changed` sur chaque fichier. Dès qu'un
    // fichier change → build.rs régénère l'empreinte → `main.rs` recompile → assets
    // ré-embarqués automatiquement.
    let mut fingerprint = String::new();
    collect_frontend(Path::new("frontend-dist"), &mut fingerprint);
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR manquant");
    fs::write(Path::new(&out_dir).join("frontend_fingerprint.txt"), fingerprint)
        .expect("écriture de l'empreinte frontend impossible");

    tauri_build::build();
}

fn collect_frontend(dir: &Path, acc: &mut String) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            collect_frontend(&path, acc);
        } else if let Ok(meta) = fs::metadata(&path) {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            acc.push_str(&format!("{}:{}:{}\n", path.display(), meta.len(), mtime));
        }
    }
}
