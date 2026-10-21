//! Versionnage des flux de contenu (chantier « undo par versionnage »).
//!
//! Chaque édition native mémorise le flux de contenu de la page AVANT
//! modification. Un undo/redo restaure ce flux EXACTEMENT — plus besoin de
//! recalculer une « édition inverse » par diff de texte (fragile quand
//! l'analyse re-segmente les blocs). Les objets ajoutés au document par les
//! éditions (polices de secours embarquées) restent en place : orphelins
//! inoffensifs, réutilisés si l'édition est refaite.

use lopdf::{Dictionary, Document, Object, ObjectId};

/// Point de restauration d'une page : flux de contenu ET ressources effectives.
/// Le chemin PDFium (`regenerate_content`) renomme les ressources de la page
/// (/F4 → /FXF1, /X8 → /FXX1) : remettre l'ancien flux sans ses ressources
/// laisse des noms introuvables (texte en police de secours, images absentes).
#[derive(Clone, Debug)]
pub struct PageBaseline {
    pub content: Vec<u8>,
    resources: Option<Dictionary>,
}

/// Ressources effectives de la page (héritées d'un nœud /Pages au besoin),
/// sous-dictionnaires indirects figés : PDFium peut les réécrire en place.
fn effective_page_resources(doc: &Document, page_id: ObjectId) -> Option<Dictionary> {
    let mut node_id = page_id;
    for _ in 0..64 {
        let node = doc.get_dictionary(node_id).ok()?;
        if let Ok(value) = node.get(b"Resources") {
            let mut resources = doc.dereference(value).ok()?.1.as_dict().ok()?.clone();
            for (_, entry) in resources.iter_mut() {
                if let Ok((Some(_), resolved)) = doc.dereference(entry) {
                    if resolved.as_dict().is_ok() {
                        *entry = resolved.clone();
                    }
                }
            }
            return Some(resources);
        }
        node_id = node.get(b"Parent").and_then(Object::as_reference).ok()?;
    }
    None
}

pub fn page_baseline(bytes: &[u8], page_number: u32) -> Result<PageBaseline, String> {
    let content = page_content_stream(bytes, page_number)?;
    let doc = crate::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let page_id = *doc
        .get_pages()
        .get(&page_number)
        .ok_or_else(|| "page_not_found".to_string())?;
    Ok(PageBaseline {
        content,
        resources: effective_page_resources(&doc, page_id),
    })
}

/// Restaure des pages à leur point de restauration (flux + ressources), en
/// mise à jour incrémentale.
pub fn restore_page_baselines(
    bytes: &[u8],
    changes: &[(u32, PageBaseline)],
) -> Result<Vec<u8>, String> {
    let mut doc = crate::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let baseline: Document = doc.clone();
    let pages = doc.get_pages();
    for (page_number, snapshot) in changes {
        let page_id = *pages
            .get(page_number)
            .ok_or_else(|| "page_not_found".to_string())?;
        doc.change_page_content(page_id, snapshot.content.clone())
            .map_err(|e| format!("lopdf write: {e}"))?;
        if let Some(resources) = &snapshot.resources {
            doc.get_dictionary_mut(page_id)
                .map_err(|e| format!("lopdf page: {e}"))?
                .set("Resources", Object::Dictionary(resources.clone()));
        }
    }
    crate::pdf_incremental::save_incremental(bytes, &baseline, &mut doc)
}

/// Flux de contenu DÉCODÉ et concaténé d'une page (l'unité de restauration).
pub fn page_content_stream(bytes: &[u8], page_number: u32) -> Result<Vec<u8>, String> {
    let doc = crate::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages = doc.get_pages();
    let page_id = *pages
        .get(&page_number)
        .ok_or_else(|| "page_not_found".to_string())?;
    // lopdf termine chaque flux concaténé par un '\n' artificiel : on retire
    // celui de fin pour que restaurer puis relire redonne exactement le flux.
    let mut content = doc.get_page_content(page_id);
    if content.last() == Some(&b'\n') {
        content.pop();
    }
    Ok(content)
}

/// Remplace le flux de contenu de plusieurs pages en une passe et renvoie le
/// document ré-enregistré (mise à jour incrémentale : l'original est conservé
/// tel quel, seuls les flux modifiés sont ajoutés).
pub fn replace_page_content_streams(
    bytes: &[u8],
    changes: &[(u32, Vec<u8>)],
) -> Result<Vec<u8>, String> {
    let mut doc = crate::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let baseline: Document = doc.clone();
    let pages = doc.get_pages();
    for (page_number, stream) in changes {
        let page_id = *pages
            .get(page_number)
            .ok_or_else(|| "page_not_found".to_string())?;
        doc.change_page_content(page_id, stream.clone())
            .map_err(|e| format!("lopdf write: {e}"))?;
    }
    crate::pdf_incremental::save_incremental(bytes, &baseline, &mut doc)
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

    #[test]
    fn baseline_restores_renamed_resources() {
        let original = simple_pdf("BT /F1 12 Tf 20 50 Td (Avant) Tj ET");
        let snapshot = page_baseline(&original, 1).expect("point de restauration");

        // Simule PDFium : ressource renommée /F1 → /FXF1 avec le flux associé.
        let mut doc = crate::load_document(&original).expect("lopdf");
        let page_id = *doc.get_pages().get(&1).unwrap();
        let mut renamed = Dictionary::new();
        renamed.set("Font", Object::Dictionary(Dictionary::from_iter(vec![("FXF1", Object::Reference((4, 0)))])));
        doc.get_dictionary_mut(page_id).unwrap().set("Resources", Object::Dictionary(renamed));
        doc.change_page_content(page_id, b"BT /FXF1 12 Tf 20 50 Td (Apres) Tj ET".to_vec()).unwrap();
        let mut edited = Vec::new();
        doc.save_to(&mut std::io::Cursor::new(&mut edited)).unwrap();

        let restored = restore_page_baselines(&edited, &[(1, snapshot.clone())]).expect("restauration");
        assert_eq!(page_content_stream(&restored, 1).unwrap(), snapshot.content);
        let doc = crate::load_document(&restored).expect("lopdf");
        let page_id = *doc.get_pages().get(&1).unwrap();
        let fonts = effective_page_resources(&doc, page_id).unwrap();
        let fonts = fonts.get(b"Font").and_then(Object::as_dict).unwrap();
        assert!(fonts.has(b"F1"), "la police /F1 du flux restauré doit exister");
    }
}
