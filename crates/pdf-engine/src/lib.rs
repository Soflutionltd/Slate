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
pub mod pdf_forms;
pub mod pdf_label;
pub mod pdf_mupdf;
pub mod pdf_ops;
mod pdf_positioned_edit;
pub mod pdf_stream_edit;
pub mod pdf_tools;
pub mod pdf_versioning;
