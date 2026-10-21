// Moteur PDF partagé d'Alto/Slate.
//
// Ces modules (rendu/analyse PDFium, opérations structurelles lopdf, outils,
// compression, formulaires, édition) étaient auparavant dans `src-tauri`. Ils
// sont désormais isolés ici pour être consommés à l'identique par :
//   - l'app desktop Tauri (`sofdocs-desktop`, cible native) ;
//   - le binding navigateur WASM (Phase 2).
//
// Aucun de ces modules ne dépend de Tauri : ce sont des fonctions pures
// bytes -> bytes / bytes -> structures sérialisables.
pub mod pdf_compress;
pub mod pdf_edit;
pub mod pdf_engine;
pub mod pdf_fallback_font;
pub mod pdf_font_subset;
pub mod pdf_forms;
pub mod pdf_incremental;
pub mod pdf_label;
pub mod pdf_mupdf;
pub mod pdf_ops;
mod pdf_positioned_edit;
pub mod pdf_stream_edit;
pub mod pdf_tools;
pub mod pdf_versioning;

/// Plafond de décompression par flux (object streams / xref streams décodés au
/// chargement) : 256 Mio. Une « bombe de décompression » (quelques Ko gonflant
/// en Go) est rejetée avec `DecompressError::MemoryLimitExceeded` au lieu
/// d'épuiser la mémoire. Les flux d'images ne sont pas décodés au chargement.
pub const MAX_DECOMPRESSED_STREAM_BYTES: usize = 256 * 1024 * 1024;

/// Charge un PDF avec lopdf en appliquant les garde-fous du moteur. À utiliser
/// à la place de `Document::load_mem` partout dans Slate.
pub fn load_document(bytes: &[u8]) -> lopdf::Result<lopdf::Document> {
    lopdf::Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions {
            max_decompressed_size: Some(MAX_DECOMPRESSED_STREAM_BYTES),
            ..lopdf::LoadOptions::default()
        },
    )
}
