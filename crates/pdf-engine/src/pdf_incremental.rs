//! Sauvegarde incrémentale (PDF 32000 §7.5.6) pour les éditions natives.
//!
//! Chaque édition de texte ré-écrivait tout le document (parse + sérialisation
//! complète) : coûteux sur un scan de 50 Mo, à chaque frappe validée. Ici, on
//! compare le document édité à son état d'avant édition et on n'AJOUTE à la
//! fin du fichier que les objets modifiés/ajoutés + une nouvelle table xref
//! (`/Prev` → table précédente). Le fichier reste un PDF valide à chaque étape.
//!
//! Vie privée : les révisions précédentes restent physiquement dans le fichier
//! (un texte supprimé reste lisible dans l'ancien flux). D'où `compact_document`
//! — réécriture complète, sans historique — à l'enregistrement final et à
//! l'export ; l'incrémental ne sert qu'au travail en cours (autosave/brouillon).

use lopdf::{Document, IncrementalDocument, SaveOptions};

/// Sérialise `edited` comme mise à jour incrémentale de `prev_bytes`
/// (dont `baseline` est le chargement lopdf AVANT modification).
///
/// Repli sur une réécriture complète quand l'incrémental n'est pas applicable :
/// document chiffré (lopdf impose une révision précédente déchiffrée) ou objets
/// supprimés (une mise à jour incrémentale ne sait que remplacer/ajouter).
pub fn save_incremental(
    prev_bytes: &[u8],
    baseline: &Document,
    edited: &mut Document,
) -> Result<Vec<u8>, String> {
    let removed_any = baseline
        .objects
        .keys()
        .any(|id| !edited.objects.contains_key(id));
    if baseline.is_encrypted() || baseline.encryption_state.is_some() || removed_any {
        return save_full(edited);
    }

    let mut incremental = IncrementalDocument::create_from(prev_bytes.to_vec(), baseline.clone());
    let mut changed = 0usize;
    for (id, object) in edited.objects.iter() {
        if baseline.objects.get(id) != Some(object) {
            incremental.new_document.objects.insert(*id, object.clone());
            changed += 1;
        }
    }
    if changed == 0 && baseline.trailer == edited.trailer {
        return Ok(prev_bytes.to_vec());
    }
    // Le trailer édité peut porter un nouveau /Root ou /Info ; /Prev est déjà
    // posé par `new_from_prev` et doit être conservé.
    let prev_offset = incremental.new_document.trailer.get(b"Prev").cloned().ok();
    for (key, value) in edited.trailer.iter() {
        if key == b"Prev" || key == b"XRefStm" || key == b"Size" {
            continue;
        }
        incremental
            .new_document
            .trailer
            .set(key.clone(), value.clone());
    }
    if let Some(prev) = prev_offset {
        incremental.new_document.trailer.set(b"Prev", prev);
    }
    incremental.new_document.max_id = edited.max_id.max(baseline.max_id);
    incremental.new_document.version = edited.version.clone();

    let mut out = Vec::with_capacity(prev_bytes.len() + 4096);
    incremental
        .save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("lopdf incremental save: {e}"))?;
    Ok(out)
}

fn save_full(doc: &mut Document) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("lopdf save: {e}"))?;
    Ok(out)
}

/// Réécriture complète et compacte : plus aucune révision antérieure, objets
/// orphelins (anciens flux de contenu, polices inutilisées) supprimés, flux
/// d'objets + xref stream compressés. À appeler à l'enregistrement final.
pub fn compact_document(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut doc = crate::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    if doc.is_encrypted() {
        // Document encore chiffré : impossible de le réécrire sans le mot de
        // passe. Les octets restent valides tels quels.
        return Ok(bytes.to_vec());
    }
    doc.prune_objects();
    // Un trailer hérité d'un xref stream garde des clés propres au flux.
    for key in [
        b"Type".as_slice(),
        b"Filter",
        b"DecodeParms",
        b"Length",
        b"W",
        b"Index",
    ] {
        doc.trailer.remove(key);
    }
    let mut out = Vec::new();
    let options = SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .compression_level(9)
        .build();
    doc.save_with_options(&mut std::io::Cursor::new(&mut out), options)
        .map_err(|e| format!("lopdf compact save: {e}"))?;
    Ok(out)
}

/// Nombre de révisions (sections xref chaînées par /Prev) — 1 pour un fichier
/// réécrit d'un bloc. Diagnostic/test.
pub fn revision_count(bytes: &[u8]) -> usize {
    bytes.windows(9).filter(|w| *w == b"startxref").count()
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

    fn edit_content(bytes: &[u8], new_content: &[u8]) -> Vec<u8> {
        let mut doc = crate::load_document(bytes).expect("load");
        let baseline = doc.clone();
        let page_id = *doc.get_pages().get(&1).expect("page 1");
        doc.change_page_content(page_id, new_content.to_vec())
            .expect("change");
        save_incremental(bytes, &baseline, &mut doc).expect("incremental")
    }

    #[test]
    fn incremental_appends_and_stays_readable() {
        let original = simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET");
        let edited = edit_content(&original, b"BT /F1 12 Tf 20 50 Td (Apres) Tj ET");
        assert!(
            edited.starts_with(&original),
            "le fichier d'origine doit être préservé tel quel"
        );
        assert_eq!(revision_count(&edited), 2);

        let doc = crate::load_document(&edited).expect("relecture lopdf");
        let page_id = *doc.get_pages().get(&1).unwrap();
        let content = String::from_utf8_lossy(&doc.get_page_content(page_id)).to_string();
        assert!(content.contains("Apres"), "{content}");
        assert!(!content.contains("Avant"));

        // Deuxième édition : s'empile sur la première.
        let again = edit_content(&edited, b"BT /F1 12 Tf 20 50 Td (Encore) Tj ET");
        assert!(again.starts_with(&edited));
        assert_eq!(revision_count(&again), 3);
        let doc = crate::load_document(&again).unwrap();
        let page_id = *doc.get_pages().get(&1).unwrap();
        assert!(String::from_utf8_lossy(&doc.get_page_content(page_id)).contains("Encore"));
    }

    #[test]
    fn incremental_on_xref_stream_document() {
        // Document produit par notre propre sauvegarde « moderne » (xref stream
        // + object streams) : la mise à jour doit aussi être un xref stream.
        let modern = compact_document(&simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET")).unwrap();
        let edited = edit_content(&modern, b"BT /F1 12 Tf 20 50 Td (Apres) Tj ET");
        assert!(edited.starts_with(&modern));
        let doc = crate::load_document(&edited).expect("relecture lopdf");
        let page_id = *doc.get_pages().get(&1).unwrap();
        assert!(String::from_utf8_lossy(&doc.get_page_content(page_id)).contains("Apres"));
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn pdfium_reads_incremental_revisions() {
        // PDFium (rendu/analyse) doit suivre la chaîne /Prev : table classique
        // ET xref stream.
        for base in [
            simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET"),
            compact_document(&simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET")).unwrap(),
        ] {
            let edited = edit_content(&base, b"BT /F1 12 Tf 20 50 Td (Apres) Tj ET");
            let analysis = crate::pdf_engine::analyze_pdf_page(&edited, 1).expect("pdfium");
            assert_eq!(analysis.engine, "pdfium");
            let text: String = analysis.blocks.iter().map(|b| b.text.as_str()).collect();
            assert!(text.contains("Apres"), "{text}");
            assert!(!text.contains("Avant"), "{text}");
        }
    }

    #[test]
    fn compact_drops_history() {
        let original = simple_pdf("BT /F1 12 Tf 20 50 Td (SECRET) Tj ET");
        let edited = edit_content(&original, b"BT /F1 12 Tf 20 50 Td (Public) Tj ET");
        assert!(
            edited.windows(6).any(|w| w == b"SECRET"),
            "l'incrémental garde l'historique"
        );

        let compact = compact_document(&edited).expect("compact");
        assert_eq!(revision_count(&compact), 1);
        assert!(
            !compact.windows(6).any(|w| w == b"SECRET"),
            "la compaction doit effacer l'historique"
        );
        let doc = crate::load_document(&compact).unwrap();
        let page_id = *doc.get_pages().get(&1).unwrap();
        assert!(String::from_utf8_lossy(&doc.get_page_content(page_id)).contains("Public"));
    }

    #[test]
    fn unchanged_document_returns_same_bytes() {
        let original = simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET");
        let mut doc = crate::load_document(&original).unwrap();
        let baseline = doc.clone();
        let out = save_incremental(&original, &baseline, &mut doc).unwrap();
        assert_eq!(out, original);
    }
}
