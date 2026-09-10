//! Corpus de régression (chantier 4) : exerce le moteur d'édition sur des PDF
//! synthétiques variés ET sur tous les documents RÉELS déposés dans
//! `tests/corpus/private/` (gitignoré — dépôt public). Voir corpus/README.md.
//!
//! Invariants, pour CHAQUE document :
//! 1. l'analyse réussit, le texte des blocs est aligné avec leurs glyphes ;
//! 2. une insertion native réussit — ou échoue avec un code d'erreur CONNU
//!    (jamais de corruption silencieuse) ;
//! 3. après insertion, le texte du document est exactement l'original avec le
//!    caractère en place, et rien d'autre n'a changé ;
//! 4. une suppression native retire exactement le caractère visé ;
//! 5. la restauration du flux d'origine (undo par versionnage) ramène la page
//!    exactement à son état initial.

use alto_pdf_engine::pdf_engine::{analyze_pdf_page, edit_pdf_text, pdfium_guard, PdfAnalysis};
use alto_pdf_engine::pdf_versioning::{page_content_stream, replace_page_content_streams};

fn pdfium_available() -> bool {
    if pdfium_guard().is_err() {
        eprintln!("PDFium indisponible : corpus ignoré.");
        return false;
    }
    true
}

// ─── Générateur de PDF synthétiques ──────────────────────────────────────────

fn build_pdf(objects: Vec<String>) -> Vec<u8> {
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

fn pdf_with_content(content: &str) -> Vec<u8> {
    let stream = format!(
        "<< /Length {} >>\nstream\n{}\nendstream",
        content.len(),
        content
    );
    build_pdf(vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        stream,
    ])
}

fn synthetic_corpus() -> Vec<(String, Vec<u8>)> {
    vec![
        (
            "simple".to_string(),
            pdf_with_content("BT /F1 12 Tf 20 150 Td (Facture 2024-118) Tj ET"),
        ),
        (
            "kerning_tj".to_string(),
            pdf_with_content("BT /F1 12 Tf 20 150 Td [(Mon) -40 (tant) -250 (128,50)] TJ ET"),
        ),
        (
            "colonnes".to_string(),
            pdf_with_content(
                "BT /F1 10 Tf 20 150 Td [(Designation) -8000 (Qte) -3000 (Prix)] TJ ET",
            ),
        ),
        (
            "cellule_clippee".to_string(),
            pdf_with_content(
                "q 15 130 90 30 re W n BT /F1 10 Tf 20 140 Td (Reference) Tj ET Q \
                 BT /F1 10 Tf 140 140 Td (Suite) Tj ET",
            ),
        ),
        (
            "fond_blanc_apres_texte".to_string(),
            pdf_with_content(
                "BT /F1 10 Tf 20 140 Td (Total HT) Tj ET \
                 1 1 1 rg 100 130 120 30 re f \
                 BT /F1 10 Tf 110 140 Td (128,50) Tj ET",
            ),
        ),
        (
            "multiligne".to_string(),
            pdf_with_content(
                "BT /F1 10 Tf 20 160 Td (Conditions de reglement sous) Tj ET \
                 BT /F1 10 Tf 20 148 Td (trente jours fin de mois) Tj ET",
            ),
        ),
        (
            "matrice_reduite".to_string(),
            pdf_with_content(
                "q 0.5 0 0 0.5 0 0 cm BT /F1 20 Tf 40 280 Td (Echelle reduite) Tj ET Q",
            ),
        ),
        (
            "operateur_quote".to_string(),
            pdf_with_content("BT /F1 12 Tf 20 160 Td 14 TL (Premier) Tj T* (Second) ' ET"),
        ),
    ]
}

fn private_corpus() -> Vec<(String, Vec<u8>)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/private");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut docs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            // Extension .pdf ne garantit rien : un JPEG renommé (scan
            // « compressé ») n'a rien à faire dans les invariants d'édition.
            // L'en-tête %PDF- peut être précédé d'un préambule (spec : jusqu'à
            // 1024 octets de junk tolérés par les lecteurs).
            let is_pdf = bytes
                .windows(5)
                .take(1024)
                .any(|w| w == b"%PDF-");
            if !is_pdf {
                eprintln!("{name}: pas un PDF (en-tête %PDF- absent) — ignoré.");
                continue;
            }
            docs.push((name, bytes));
        }
    }
    docs.sort_by(|a, b| a.0.cmp(&b.0));
    docs
}

// ─── Invariants ──────────────────────────────────────────────────────────────

/// Codes d'erreur ACCEPTÉS : le moteur a le droit de refuser une édition
/// (le frontend bascule en HTML), jamais de corrompre en silence.
const KNOWN_ERRORS: &[&str] = &[
    "multi_object_edit",
    "multi_line_object",
    "multi_column_object",
    "unordered_object",
    "unmapped_glyph",
    "missing_glyphs",
    "unencodable_insert",
    "layout_divergence",
    "clipped_insert",
    "covered_insert",
    "insert_collision",
    "reencode_side_effects",
    "inline_image_unsupported",
    "quote_op_unsupported",
    "unsupported_encoding",
    "encrypted_document",
    "text_object_not_found",
    "show_op_not_found",
    "no_hard_anchor",
    "code_alignment",
    "resegmented",
    "no_current_font",
];

fn squeeze(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Texte non-blanc de la page en ORDRE DOCUMENT, caractères dédupliqués par
/// index de page (deux segments qui se chevauchent physiquement dupliquent les
/// caractères frontière).
fn page_doc_text(analysis: &PdfAnalysis) -> String {
    let mut chars: Vec<(i64, &str)> = analysis
        .blocks
        .iter()
        .flat_map(|b| b.chars.iter())
        .filter(|c| !c.text.trim().is_empty() && c.page_char_index >= 0)
        .map(|c| (c.page_char_index, c.text.as_str()))
        .collect();
    chars.sort_by_key(|&(i, _)| i);
    chars.dedup_by_key(|&mut (i, _)| i);
    chars.into_iter().map(|(_, t)| t).collect()
}

/// Réplique du regroupement en lignes du frontend (pdfCharLines) : proximité
/// verticale 0.45 × hauteur max, lignes haut→bas, caractères gauche→droite.
fn frontend_char_lines(
    chars: &[alto_pdf_engine::pdf_engine::PdfCharBox],
) -> Vec<Vec<&alto_pdf_engine::pdf_engine::PdfCharBox>> {
    let mut lines: Vec<(f64, f64, Vec<&alto_pdf_engine::pdf_engine::PdfCharBox>)> = Vec::new();
    for ch in chars {
        let ch_center = ch.y + ch.height / 2.0;
        let found = lines.iter_mut().find(|(y, h, _)| {
            let center = *y + *h / 2.0;
            (center - ch_center).abs() <= h.max(ch.height) * 0.45
        });
        match found {
            Some((_, _, cs)) => cs.push(ch),
            None => lines.push((ch.y, ch.height, vec![ch])),
        }
    }
    lines.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    for (_, _, cs) in &mut lines {
        cs.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    }
    lines.into_iter().map(|(_, _, cs)| cs).collect()
}

/// Réplique des règles d'ÉLIGIBILITÉ À L'ÉDITION NATIVE du frontend
/// (block-state.js + tryNativeTextEdit). Ok(()) = le bloc reste natif au
/// double-clic (caret dessiné actif, frappe sans changement d'état).
fn frontend_native_eligibility(
    block: &alto_pdf_engine::pdf_engine::PdfEditBlock,
) -> Result<(), String> {
    // Chaque glyphe non blanc doit être mappé sur la page texte.
    if block
        .chars
        .iter()
        .any(|c| c.page_char_index < 0 && !c.text.chars().all(char::is_whitespace))
    {
        return Err("glyphe non mappé (pci<0)".to_string());
    }
    let is_multiline = block.text.contains('\n');
    if is_multiline {
        let rebuilt = frontend_char_lines(&block.chars)
            .iter()
            .map(|cs| cs.iter().map(|c| c.text.as_str()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        if rebuilt != block.text {
            return Err(format!(
                "multiligne désaligné (texte {:?} ≠ glyphes {:?})",
                block.text, rebuilt
            ));
        }
    } else {
        let from_chars: String = block.chars.iter().map(|c| c.text.as_str()).collect();
        if from_chars != block.text {
            return Err(format!(
                "monoligne désaligné (texte {:?} ≠ glyphes {:?})",
                block.text, from_chars
            ));
        }
    }
    // Indices page strictement croissants dans l'ordre du diff.
    let ordered: Vec<&alto_pdf_engine::pdf_engine::PdfCharBox> = if is_multiline {
        frontend_char_lines(&block.chars).into_iter().flatten().collect()
    } else {
        block.chars.iter().collect()
    };
    let mut last = -1i64;
    for ch in ordered {
        if ch.page_char_index < 0 {
            continue;
        }
        if ch.page_char_index <= last {
            return Err("indices page non croissants".to_string());
        }
        last = ch.page_char_index;
    }
    Ok(())
}

fn exercise_document(name: &str, bytes: &[u8], page: u32) {
    let analysis =
        analyze_pdf_page(bytes, page).unwrap_or_else(|e| panic!("{name}: analyse impossible ({e})"));
    let page_height = analysis.page_height.max(1.0);

    // Invariant 1 : TOUS les blocs texte ordinaires sont éligibles à l'édition
    // native (alignement texte ↔ glyphes garanti PAR CONSTRUCTION depuis que
    // le texte des lignes est reconstruit depuis les glyphes fusionnés). Seule
    // exception légitime : glyphes peints dans le désordre du flux (logos
    // multi-couches, textes superposés) → indices page non croissants, le
    // frontend les exclut de l'édition. Tout AUTRE échec (désalignement,
    // glyphe non mappé) est une régression : caret dessiné désactivé et
    // bascule HTML/changement de police à la première frappe.
    let aligned = |block: &&alto_pdf_engine::pdf_engine::PdfEditBlock| -> bool {
        frontend_native_eligibility(block).is_ok()
    };
    let mut eligible_count = 0usize;
    for block in analysis.blocks.iter().filter(|b| b.kind == "text" && !b.chars.is_empty()) {
        match frontend_native_eligibility(block) {
            Ok(()) => eligible_count += 1,
            Err(reason) if reason == "indices page non croissants" => {}
            Err(reason) => {
                let head: String = block.text.chars().take(50).collect();
                panic!("{name}: bloc {head:?} inéligible au natif : {reason}");
            }
        }
    }
    assert!(
        eligible_count > 0 || analysis.blocks.iter().all(|b| b.kind != "text"),
        "{name}: AUCUN bloc aligné texte/glyphes (plus rien n'est éditable nativement)"
    );

    let before_analysis = analyze_pdf_page(bytes, page).unwrap();
    let before_text = page_doc_text(&before_analysis);
    if before_text.is_empty() {
        return; // page sans texte : rien à éditer.
    }
    let baseline_stream = page_content_stream(bytes, page)
        .unwrap_or_else(|e| panic!("{name}: flux de contenu illisible ({e})"));

    // Ancre : premier caractère non blanc du plus GRAND bloc ALIGNÉ (le
    // frontend n'édite nativement que ces blocs-là).
    let block = analysis
        .blocks
        .iter()
        .filter(|b| aligned(b))
        .max_by_key(|b| b.chars.iter().filter(|c| !c.text.trim().is_empty()).count())
        .unwrap();
    let anchor = block
        .chars
        .iter()
        .find(|c| !c.text.trim().is_empty() && c.page_char_index >= 0)
        .expect("ancre présente");
    // Ordinal de l'ancre parmi les caractères non blancs de la page (ordre
    // document, dédupliqué) : position du X inséré dans le texte attendu.
    let anchor_ordinal = {
        let mut seen: Vec<i64> = before_analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .filter(|c| !c.text.trim().is_empty() && c.page_char_index >= 0)
            .map(|c| c.page_char_index)
            .collect();
        seen.sort_unstable();
        seen.dedup();
        seen.iter().position(|&i| i == anchor.page_char_index).unwrap()
    };

    // Invariant 2/3 : insertion après l'ancre.
    match edit_pdf_text(
        bytes,
        page,
        &[],
        anchor.page_char_index,
        -1,
        "X",
        0.0,
        page_height,
        1.0,
        None,
        None,
    ) {
        Err(err) => {
            let code = err.split(&[':', ' '][..]).next().unwrap_or(&err);
            assert!(
                KNOWN_ERRORS.iter().any(|k| err == *k || code == *k),
                "{name}: erreur INCONNUE du moteur : {err:?}"
            );
        }
        Ok(outcome) => {
            let after = analyze_pdf_page(&outcome.bytes, page).unwrap();
            let after_text = page_doc_text(&after);
            let mut expected: String = before_text.chars().take(anchor_ordinal + 1).collect();
            expected.push('X');
            expected.extend(before_text.chars().skip(anchor_ordinal + 1));
            assert_eq!(
                after_text, expected,
                "{name}: le document après insertion ne correspond pas"
            );

            // Invariant 5 : la restauration du flux d'origine ramène la page
            // EXACTEMENT à son état initial (undo par versionnage).
            let restored =
                replace_page_content_streams(&outcome.bytes, &[(page, baseline_stream.clone())])
                    .unwrap_or_else(|e| panic!("{name}: restauration impossible ({e})"));
            let restored_text = page_doc_text(&analyze_pdf_page(&restored, page).unwrap());
            assert_eq!(
                restored_text, before_text,
                "{name}: la restauration du flux d'origine n'a pas ramené le texte initial"
            );
        }
    }

    // Invariant 4 : suppression de l'ancre elle-même.
    match edit_pdf_text(
        bytes,
        page,
        &[anchor.page_char_index as u32],
        -1,
        -1,
        "",
        0.0,
        page_height,
        1.0,
        None,
        None,
    ) {
        Err(err) => {
            let code = err.split(&[':', ' '][..]).next().unwrap_or(&err);
            assert!(
                KNOWN_ERRORS.iter().any(|k| err == *k || code == *k),
                "{name}: erreur INCONNUE du moteur (suppression) : {err:?}"
            );
        }
        Ok(outcome) => {
            let after_text = page_doc_text(&analyze_pdf_page(&outcome.bytes, page).unwrap());
            let expected: String = before_text
                .chars()
                .enumerate()
                .filter(|&(i, _)| i != anchor_ordinal)
                .map(|(_, c)| c)
                .collect();
            assert_eq!(
                after_text, expected,
                "{name}: le document après suppression ne correspond pas"
            );
        }
    }
}

#[test]
fn corpus_synthetic_documents() {
    if !pdfium_available() {
        return;
    }
    for (name, bytes) in synthetic_corpus() {
        exercise_document(&name, &bytes, 1);
    }
}

#[test]
fn corpus_private_documents() {
    if !pdfium_available() {
        return;
    }
    let docs = private_corpus();
    if docs.is_empty() {
        eprintln!("corpus privé vide (tests/corpus/private/) : ignoré.");
        return;
    }
    for (name, bytes) in docs {
        // Toutes les pages des documents réels (bornées à 5 pour la durée).
        let pages = alto_pdf_engine::pdf_ops::page_count(bytes.clone()).unwrap_or(1).min(5);
        for page in 1..=pages {
            exercise_document(&name, &bytes, page);
        }
    }
}

#[test]
fn corpus_repeated_typing_stress() {
    if !pdfium_available() {
        return;
    }
    // Frappe répétée (20 insertions au même point) sur un document à colonnes :
    // le scénario « IACCESDIVE » généralisé. Le texte doit rester exact à
    // chaque étape, ou l'édition être refusée proprement — jamais corrompue.
    let mut bytes =
        pdf_with_content("BT /F1 10 Tf 20 150 Td [(Article) -6000 (Prix unitaire)] TJ ET");
    let mut expected = squeeze("ArticlePrixunitaire");
    for step in 0..20 {
        let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
        let anchor = analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .filter(|c| !c.text.trim().is_empty() && c.page_char_index >= 0)
            .min_by_key(|c| c.page_char_index)
            .expect("ancre");
        match edit_pdf_text(&bytes, 1, &[], anchor.page_char_index, -1, "X", 0.0, 200.0, 1.0, None, None)
        {
            Err(err) => {
                let code = err.split(&[':', ' '][..]).next().unwrap_or(&err);
                assert!(
                    KNOWN_ERRORS.iter().any(|k| err == *k || code == *k),
                    "étape {step}: erreur inconnue {err:?}"
                );
                return; // refus propre : fin du stress.
            }
            Ok(outcome) => {
                bytes = outcome.bytes;
                expected.insert(1, 'X');
                let text = page_doc_text(&analyze_pdf_page(&bytes, 1).unwrap());
                assert_eq!(text, expected, "étape {step}: texte corrompu");
            }
        }
    }
}
