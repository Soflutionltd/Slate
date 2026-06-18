// Bibliothèque partagée entre le binaire principal (app Tauri) et le serveur
// MCP stdio `alto-mcp` : moteurs PDF (PDFium), opérations, OCR et client LLM.
pub mod llm;
pub mod ocr;
pub mod pdf_sign;
pub mod system_fonts;

// Moteur PDF déplacé dans le crate partagé `alto-pdf-engine`. On le ré-exporte
// sous les mêmes chemins (`crate::pdf_engine`, `sofdocs_desktop::pdf_ops`, …) pour
// que le code existant (main.rs, bin/alto_mcp.rs, ocr.rs) reste inchangé.
pub use alto_pdf_engine::{pdf_compress, pdf_edit, pdf_engine, pdf_forms, pdf_ops, pdf_tools};
