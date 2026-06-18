// Test E2E des outils MCP d'inspection/édition fine (pdf_edit).
//
// Construit un PDF d'exemple multipage (texte + image), puis vérifie :
//   1. pdf_layout       : blocs texte et images avec IDs stables
//   2. pdf_replace_text : remplacement (mode exact + regex)
//   3. pdf_edit_region  : redaction + réinsertion auto-ajustée
//   4. pdf_replace_image: remplacement des pixels par image_id
//   5. pdf_redact       : le texte caviardé n'est plus extractible
//   6. pdf_set_metadata : titre/auteur corrigés
//   7. pdf_stamp        : mention apposée
//   8. pdf_delete_image : image purgée
// À chaque étape : le fichier source reste intact et un nouveau fichier est créé.
//
// Usage : cargo run --example mcp_e2e

use image::{Rgb, RgbImage};
use pdfium_render::prelude::*;
use sofdocs_desktop::{pdf_edit, pdf_engine, pdf_ops};

fn main() {
    let dir = std::env::temp_dir().join("alto-mcp-e2e");
    std::fs::create_dir_all(&dir).expect("temp dir");

    // --- 0) Construire le PDF d'exemple -----------------------------------
    let source_bytes = build_sample_pdf();
    let source_path = dir.join("source.pdf");
    std::fs::write(&source_path, &source_bytes).expect("write source");
    let source_hash = hash(&source_bytes);
    println!("Source: {} ({} octets)", source_path.display(), source_bytes.len());

    // --- 1) pdf_layout ------------------------------------------------------
    let layout = pdf_edit::layout(&source_bytes, None).expect("layout");
    let pages = layout["pages"].as_array().expect("pages array");
    assert_eq!(pages.len(), 2, "le document doit avoir 2 pages");
    let page1_blocks = pages[0]["text_blocks"].as_array().expect("text blocks");
    assert!(!page1_blocks.is_empty(), "page 1 doit avoir des blocs texte");
    let confidential_block = page1_blocks
        .iter()
        .find(|b| b["text"].as_str().unwrap_or("").contains("CONFIDENTIEL"))
        .expect("bloc CONFIDENTIEL trouvé");
    let block_id = confidential_block["block_id"].as_str().unwrap().to_string();
    let confidential_bbox: Vec<f64> = confidential_block["bbox"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let images = pages[1]["images"].as_array().expect("images page 2");
    assert_eq!(images.len(), 1, "page 2 doit avoir 1 image");
    let image_id = images[0]["image_id"].as_str().unwrap().to_string();
    println!("1. pdf_layout OK — block_id={block_id}, image_id={image_id}");

    // --- 2) pdf_replace_text (exact + regex) -------------------------------
    let outcome =
        pdf_edit::replace_text(&source_bytes, "Dupont", "Martin", None, false).expect("replace");
    assert!(outcome.count >= 1, "au moins 1 occurrence remplacée");
    let replaced_path = dir.join("etape2-remplace.pdf");
    std::fs::write(&replaced_path, &outcome.bytes).expect("write");
    assert!(extract_all_text(&outcome.bytes).contains("Martin"));
    assert!(!extract_all_text(&outcome.bytes).contains("Dupont"));

    let regex_outcome =
        pdf_edit::replace_text(&source_bytes, r"\d{2}/\d{2}/\d{4}", "01/01/2030", None, true)
            .expect("regex replace");
    assert!(regex_outcome.count >= 1, "la date doit matcher la regex");
    assert!(extract_all_text(&regex_outcome.bytes).contains("01/01/2030"));
    assert_source_intact(&source_path, &source_hash);
    println!(
        "2. pdf_replace_text OK — exact: {} occ., regex: {} occ.",
        outcome.count, regex_outcome.count
    );

    // --- 3) pdf_edit_region (via block_id) ----------------------------------
    let (page, bbox) =
        pdf_edit::resolve_block_bbox(&source_bytes, &block_id).expect("resolve block");
    let edit = pdf_edit::edit_region(
        &source_bytes,
        page,
        bbox,
        "PUBLIC",
        Some("helvetica-bold"),
        None,
        PdfColor::new(200, 0, 0, 255),
        "left",
    )
    .expect("edit_region");
    assert!(edit.removed_blocks >= 1, "le bloc d'origine doit être supprimé");
    let edited_text = extract_all_text(&edit.bytes);
    assert!(!edited_text.contains("CONFIDENTIEL"), "l'ancien texte doit disparaître");
    assert!(edited_text.contains("PUBLIC"), "le nouveau texte doit être présent");
    std::fs::write(dir.join("etape3-region.pdf"), &edit.bytes).expect("write");
    assert_source_intact(&source_path, &source_hash);
    println!(
        "3. pdf_edit_region OK — {} bloc(s) retiré(s), taille finale {:.1}pt",
        edit.removed_blocks, edit.final_size
    );

    // --- 4) pdf_replace_image ------------------------------------------------
    let blue_png = dir.join("bleu.png");
    RgbImage::from_pixel(80, 50, Rgb([0, 0, 255]))
        .save(&blue_png)
        .expect("png");
    let replaced_image =
        pdf_edit::replace_image(&source_bytes, &image_id, blue_png.to_str().unwrap())
            .expect("replace_image");
    std::fs::write(dir.join("etape4-image.pdf"), &replaced_image).expect("write");
    assert_source_intact(&source_path, &source_hash);
    println!("4. pdf_replace_image OK — pixels remplacés ({image_id})");

    // --- 5) pdf_redact : texte réellement supprimé ---------------------------
    let area_bbox = (
        confidential_bbox[0] - 2.0,
        confidential_bbox[1] - 2.0,
        confidential_bbox[2] + 2.0,
        confidential_bbox[3] + 2.0,
    );
    let redacted = pdf_edit::redact(&source_bytes, &[(1, area_bbox)], false).expect("redact");
    assert!(redacted.removed_text_blocks >= 1);
    let redacted_text = extract_all_text(&redacted.bytes);
    assert!(
        !redacted_text.contains("CONFIDENTIEL"),
        "le texte caviardé ne doit plus être extractible (copier-coller impossible)"
    );
    std::fs::write(dir.join("etape5-caviarde.pdf"), &redacted.bytes).expect("write");
    assert_source_intact(&source_path, &source_hash);
    println!(
        "5. pdf_redact OK — {} bloc(s) texte supprimé(s), texte non récupérable",
        redacted.removed_text_blocks
    );

    // --- 6) pdf_set_metadata --------------------------------------------------
    let with_meta = pdf_edit::set_metadata(
        &source_bytes,
        Some("Rapport Alto"),
        Some("Antoine Pinelli"),
        None,
        Some("alto, pdf, test"),
    )
    .expect("set_metadata");
    let properties = pdf_ops::document_properties(with_meta.clone()).expect("properties");
    let props_json = serde_json::to_string(&properties).expect("json");
    assert!(props_json.contains("Rapport Alto"), "titre mis à jour");
    assert!(props_json.contains("Antoine Pinelli"), "auteur mis à jour");
    std::fs::write(dir.join("etape6-meta.pdf"), &with_meta).expect("write");
    assert_source_intact(&source_path, &source_hash);
    println!("6. pdf_set_metadata OK — titre et auteur corrigés");

    // --- 7) pdf_stamp -----------------------------------------------------------
    let stamped = pdf_edit::stamp(
        &source_bytes,
        1,
        400.0,
        780.0,
        Some("Lu et approuvé"),
        Some("helvetica-oblique"),
        11.0,
        PdfColor::new(0, 0, 160, 255),
        None,
        None,
    )
    .expect("stamp");
    assert!(extract_all_text(&stamped).contains("Lu et approuvé"));
    std::fs::write(dir.join("etape7-estampille.pdf"), &stamped).expect("write");
    assert_source_intact(&source_path, &source_hash);
    println!("7. pdf_stamp OK — mention apposée");

    // --- 8) pdf_delete_image -----------------------------------------------------
    let without_image = pdf_edit::delete_image(&source_bytes, &image_id).expect("delete_image");
    let layout_after = pdf_edit::layout(&without_image, Some(vec![2])).expect("layout after");
    let images_after = layout_after["pages"][0]["images"].as_array().unwrap();
    assert!(images_after.is_empty(), "l'image doit être purgée");
    std::fs::write(dir.join("etape8-sans-image.pdf"), &without_image).expect("write");
    assert_source_intact(&source_path, &source_hash);
    println!("8. pdf_delete_image OK — image purgée du fichier");

    println!("\nTous les tests E2E sont passés. Fichiers dans {}", dir.display());
}

/// PDF d'exemple : page 1 avec plusieurs textes, page 2 avec un texte + image.
fn build_sample_pdf() -> Vec<u8> {
    let guard = pdf_engine::pdfium_guard().expect("pdfium");
    let pdfium = &*guard;
    let mut document = pdfium.create_new_pdf().expect("new pdf");
    let helvetica = document.fonts_mut().helvetica();

    {
        let mut page = document
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::a4())
            .expect("page 1");
        let objects = page.objects_mut();
        objects
            .create_text_object(
                PdfPoints::new(72.0),
                PdfPoints::new(770.0),
                "Contrat de prestation",
                helvetica,
                PdfPoints::new(18.0),
            )
            .expect("title");
        objects
            .create_text_object(
                PdfPoints::new(72.0),
                PdfPoints::new(730.0),
                "Client : Jean Dupont",
                helvetica,
                PdfPoints::new(12.0),
            )
            .expect("client");
        objects
            .create_text_object(
                PdfPoints::new(72.0),
                PdfPoints::new(700.0),
                "CONFIDENTIEL - diffusion interdite",
                helvetica,
                PdfPoints::new(12.0),
            )
            .expect("confidential");
        objects
            .create_text_object(
                PdfPoints::new(72.0),
                PdfPoints::new(670.0),
                "Date : 24/02/2026",
                helvetica,
                PdfPoints::new(12.0),
            )
            .expect("date");
        page.regenerate_content().expect("regen p1");
    }

    {
        let mut page = document
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::a4())
            .expect("page 2");
        let objects = page.objects_mut();
        objects
            .create_text_object(
                PdfPoints::new(72.0),
                PdfPoints::new(770.0),
                "Annexe : logo fournisseur",
                helvetica,
                PdfPoints::new(12.0),
            )
            .expect("annex");
        let logo = image::DynamicImage::ImageRgb8(RgbImage::from_pixel(80, 50, Rgb([255, 0, 0])));
        objects
            .create_image_object(
                PdfPoints::new(72.0),
                PdfPoints::new(650.0),
                &logo,
                Some(PdfPoints::new(120.0)),
                Some(PdfPoints::new(75.0)),
            )
            .expect("logo");
        page.regenerate_content().expect("regen p2");
    }

    document.save_to_bytes().expect("save sample")
}

fn extract_all_text(bytes: &[u8]) -> String {
    let guard = pdf_engine::pdfium_guard().expect("pdfium");
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .expect("load pdf");
    let mut out = String::new();
    for page in document.pages().iter() {
        out.push_str(&page.text().expect("text").all());
        out.push('\n');
    }
    out
}

fn hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn assert_source_intact(path: &std::path::Path, expected_hash: &u64) {
    let bytes = std::fs::read(path).expect("relire la source");
    assert_eq!(
        &hash(&bytes),
        expected_hash,
        "LE FICHIER SOURCE A ÉTÉ MODIFIÉ — interdit"
    );
}
