//! Intégration MuPDF (natif uniquement) — chantier « robustesse & rendu ».
//!
//! Deux rôles, complémentaires de PDFium/lopdf :
//!
//! 1. RÉPARATION À L'OUVERTURE : MuPDF est nettement plus tolérant que
//!    lopdf/PDFium face aux PDF cassés (xref corrompue, offsets faux, objets
//!    tronqués — fréquents sur les PDF générés par de vieux ERP ou re-sauvés
//!    par des outils douteux). Quand lopdf ou PDFium refusent un document, on
//!    le fait ré-écrire proprement par MuPDF : l'édition native redevient
//!    possible au lieu d'être silencieusement refusée.
//!
//! 2. RENDU RAPIDE : rendu pixmap MuPDF pour les usages NON couplés au
//!    rasteriseur d'édition (miniatures, aperçus). Le canvas d'édition, lui,
//!    reste rendu par PDFium — les bandes de frappe sont PDFium et doivent
//!    rester pixel-identiques au fond.

#![cfg(not(target_arch = "wasm32"))]

use mupdf::pdf::PdfDocument;
use mupdf::{Colorspace, Matrix};

use crate::pdf_engine::RenderedPagePng;

/// Sérialise le verrou global MuPDF : le contexte MuPDF n'est pas thread-safe
/// par défaut (un contexte par thread serait possible, mais inutilement
/// complexe pour nos usages ponctuels).
static MUPDF_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Vrai si le document s'ouvre proprement dans NOS moteurs d'édition
/// (lopdf pour le splice, PDFium pour l'analyse).
fn parses_cleanly(bytes: &[u8]) -> bool {
    if lopdf::Document::load_mem(bytes).is_err() {
        return false;
    }
    let Ok(guard) = crate::pdf_engine::pdfium_guard() else {
        // PDFium indisponible : ne pas déclencher de réécriture intempestive.
        return true;
    };
    let pdfium = &*guard;
    let ok = match pdfium.load_pdf_from_byte_slice(bytes, None) {
        Ok(doc) => doc.pages().len() > 0,
        Err(_) => false,
    };
    ok
}

/// Répare un PDF que lopdf ou PDFium ne parsent pas, en le faisant réécrire
/// par MuPDF (qui reconstruit xref et objets à la volée). Retourne :
/// - `Ok(None)` si le document est déjà sain (AUCUNE réécriture : les octets
///   d'origine restent la référence) ;
/// - `Ok(Some(bytes))` si une réparation a été appliquée ;
/// - `Err` si le document est irrécupérable (même MuPDF n'en veut pas).
pub fn repair_pdf_if_needed(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    if bytes.len() < 8 {
        return Err("not_a_pdf".to_string());
    }
    if parses_cleanly(bytes) {
        return Ok(None);
    }
    let _lock = MUPDF_LOCK.lock().map_err(|_| "mupdf lock".to_string())?;
    let doc = PdfDocument::from_bytes(bytes).map_err(|e| format!("mupdf: {e}"))?;
    if doc.needs_password().unwrap_or(false) {
        return Err("encrypted_document".to_string());
    }
    let mut out = Vec::new();
    doc.write_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("mupdf write: {e}"))?;
    drop(_lock);
    // La réécriture doit produire un document que NOS moteurs acceptent —
    // sinon on garde l'original (rien n'est pire qu'une « réparation » qui
    // casse davantage).
    if !parses_cleanly(&out) {
        return Err("repair_failed".to_string());
    }
    Ok(Some(out))
}

/// Rendu pleine page en PNG via MuPDF. Même contrat que
/// `pdf_engine::render_pdf_page_png` (scale = pixels par point PDF), pour les
/// usages découplés du rasteriseur d'édition (miniatures, aperçus).
pub fn render_pdf_page_png_mupdf(
    bytes: &[u8],
    page_number: u32,
    scale: f64,
) -> Result<RenderedPagePng, String> {
    if !(scale > 0.0) {
        return Err("invalid_scale".to_string());
    }
    let _lock = MUPDF_LOCK.lock().map_err(|_| "mupdf lock".to_string())?;
    let doc = PdfDocument::from_bytes(bytes).map_err(|e| format!("mupdf: {e}"))?;
    let index = page_number
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())?;
    let page = doc
        .load_page(index as i32)
        .map_err(|e| format!("mupdf page: {e}"))?;
    let matrix = Matrix::new_scale(scale as f32, scale as f32);
    let pixmap = page
        .to_pixmap(&matrix, &Colorspace::device_rgb(), false, true)
        .map_err(|e| format!("mupdf render: {e}"))?;
    let width = pixmap.width();
    let height = pixmap.height();
    let samples = pixmap.samples().to_vec();
    drop(_lock);

    let image = image::RgbImage::from_raw(width, height, samples)
        .ok_or_else(|| "mupdf pixmap shape".to_string())?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("png encode: {e}"))?;
    Ok(RenderedPagePng {
        png_base64: crate::pdf_engine::base64_encode(&png),
        width_px: width,
        height_px: height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_pdf() -> Vec<u8> {
        let content = "BT /F1 12 Tf 20 50 Td (Repare) Tj ET";
        let stream = format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            content.len(),
            content
        );
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            stream,
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, obj).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for off in &offsets {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref
            )
            .as_bytes(),
        );
        out
    }

    #[test]
    fn healthy_pdf_is_left_untouched() {
        let bytes = minimal_pdf();
        assert!(repair_pdf_if_needed(&bytes).expect("sain").is_none());
    }

    #[test]
    fn broken_xref_is_repaired() {
        let mut bytes = minimal_pdf();
        // Corrompre la table xref : offsets remplacés par du bruit. lopdf
        // refuse un tel document, MuPDF le reconstruit.
        // « startxref » contient aussi « xref » : on cible la table elle-même.
        let xref_pos = bytes
            .windows(6)
            .rposition(|w| w == b"\nxref\n")
            .expect("xref présent");
        for b in &mut bytes[xref_pos + 8..xref_pos + 42] {
            if b.is_ascii_digit() {
                *b = b'9';
            }
        }
        assert!(
            lopdf::Document::load_mem(&bytes).is_err(),
            "le PDF corrompu doit faire échouer lopdf pour que le test soit probant"
        );
        let repaired = repair_pdf_if_needed(&bytes)
            .expect("réparable")
            .expect("réparation appliquée");
        assert!(lopdf::Document::load_mem(&repaired).is_ok());
        // Le contenu textuel survit à la réparation.
        let doc = lopdf::Document::load_mem(&repaired).unwrap();
        let pages = doc.get_pages();
        let page_id = *pages.get(&1).unwrap();
        let content = doc.get_page_content(page_id).unwrap();
        assert!(String::from_utf8_lossy(&content).contains("Repare"));
    }

    #[test]
    fn mupdf_renders_page_to_png() {
        let bytes = minimal_pdf();
        let rendered = render_pdf_page_png_mupdf(&bytes, 1, 2.0).expect("rendu");
        assert_eq!(rendered.width_px, 600);
        assert_eq!(rendered.height_px, 200);
        assert!(!rendered.png_base64.is_empty());
    }
}
