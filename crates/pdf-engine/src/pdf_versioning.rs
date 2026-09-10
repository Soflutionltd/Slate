//! Versionnage des flux de contenu (chantier « undo par versionnage »).
//!
//! Chaque édition native mémorise le flux de contenu de la page AVANT
//! modification. Un undo/redo restaure ce flux EXACTEMENT — plus besoin de
//! recalculer une « édition inverse » par diff de texte (fragile quand
//! l'analyse re-segmente les blocs). Les objets ajoutés au document par les
//! éditions (polices de secours embarquées) restent en place : orphelins
//! inoffensifs, réutilisés si l'édition est refaite.

use lopdf::Document;

/// Flux de contenu DÉCODÉ et concaténé d'une page (l'unité de restauration).
pub fn page_content_stream(bytes: &[u8], page_number: u32) -> Result<Vec<u8>, String> {
    let doc = Document::load_mem(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages = doc.get_pages();
    let page_id = *pages
        .get(&page_number)
        .ok_or_else(|| "page_not_found".to_string())?;
    doc.get_page_content(page_id)
        .map_err(|e| format!("lopdf content: {e}"))
}

/// Remplace le flux de contenu de plusieurs pages en une passe et renvoie le
/// document complet ré-enregistré.
pub fn replace_page_content_streams(
    bytes: &[u8],
    changes: &[(u32, Vec<u8>)],
) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages = doc.get_pages();
    for (page_number, stream) in changes {
        let page_id = *pages
            .get(page_number)
            .ok_or_else(|| "page_not_found".to_string())?;
        doc.change_page_content(page_id, stream.clone())
            .map_err(|e| format!("lopdf write: {e}"))?;
    }
    let mut out = Vec::new();
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("lopdf save: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_pdf(content: &str) -> Vec<u8> {
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
    fn content_stream_round_trip_restores_page() {
        let original = simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET");
        let before = page_content_stream(&original, 1).expect("lecture flux");
        assert!(String::from_utf8_lossy(&before).contains("Avant"));

        // Simule une édition : nouveau flux.
        let edited = replace_page_content_streams(
            &original,
            &[(1, b"BT /F1 12 Tf 20 50 Td (Apres) Tj ET".to_vec())],
        )
        .expect("remplacement");
        let now = page_content_stream(&edited, 1).expect("lecture flux");
        assert!(String::from_utf8_lossy(&now).contains("Apres"));

        // Restauration : on rejoue le flux d'avant sur le document édité.
        let restored = replace_page_content_streams(&edited, &[(1, before.clone())]).expect("restauration");
        let back = page_content_stream(&restored, 1).expect("lecture flux");
        assert_eq!(back, before);
    }
}
