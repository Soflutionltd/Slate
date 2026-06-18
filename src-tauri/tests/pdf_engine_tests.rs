//! Tests d'intégration du moteur PDF (PDFium + lopdf).
//!
//! Couvre les opérations critiques : caviardage RÉEL (le texte doit disparaître,
//! pas seulement être masqué), opérations de page (delete/extract/reorder/rotate/
//! merge), métadonnées, et robustesse face à un PDF invalide (jamais de panic).
//!
//! PDFium est chargé depuis `CARGO_MANIFEST_DIR` (voir `pdfium_search_dirs`), où
//! `libpdfium.dylib` est présent en dev/CI.

use std::io::Cursor;

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use sofdocs_desktop::{pdf_edit, pdf_engine, pdf_ops, pdf_tools};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Construit un PDF A4 multipage avec du texte Helvetica EXTRACTIBLE.
/// `pages[i]` = lignes de la page i ; chaque ligne est un objet texte distinct
/// (indispensable pour tester que le caviardage retire la bonne ligne sans
/// emporter ses voisines).
fn build_pdf(pages: &[&[&str]]) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    });

    let pages_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::new();

    for lines in pages {
        let mut ops: Vec<Operation> = Vec::new();
        let mut y = 760i64;
        for line in *lines {
            ops.push(Operation::new("BT", vec![]));
            ops.push(Operation::new(
                "Tf",
                vec![Object::Name(b"F1".to_vec()), Object::Integer(24)],
            ));
            ops.push(Operation::new(
                "Td",
                vec![Object::Integer(72), Object::Integer(y)],
            ));
            ops.push(Operation::new("Tj", vec![Object::string_literal(*line)]));
            ops.push(Operation::new("ET", vec![]));
            y -= 48;
        }
        let content = Content { operations: ops };
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            content.encode().expect("encode content stream"),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(595),
                Object::Integer(842),
            ],
            "Resources" => resources_id,
        });
        kids.push(page_id.into());
    }

    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
        }),
    );

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut buf = Vec::new();
    doc.save_to(&mut Cursor::new(&mut buf)).expect("save pdf");
    buf
}

/// Texte extrait d'une page (1-based) via le moteur d'analyse de l'app.
fn page_text(bytes: &[u8], page: u32) -> String {
    let analysis = pdf_engine::analyze_pdf_page(bytes, page).expect("analyze page");
    analysis
        .blocks
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn page_count(bytes: &[u8]) -> u32 {
    pdf_ops::page_count(bytes.to_vec()).expect("page count")
}

fn page_rotation(bytes: &[u8], page_1based: u32) -> i64 {
    let doc = Document::load_mem(bytes).expect("reload pdf");
    let pages = doc.get_pages();
    let id = *pages.get(&page_1based).expect("page exists");
    let dict = doc.get_dictionary(id).expect("page dict");
    dict.get(b"Rotate")
        .ok()
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(0)
}

fn info_title(bytes: &[u8]) -> Option<String> {
    let doc = Document::load_mem(bytes).ok()?;
    let id = doc.trailer.get(b"Info").ok()?.as_reference().ok()?;
    match doc.get_object(id).ok()? {
        Object::Dictionary(dict) => match dict.get(b"Title").ok()? {
            Object::String(raw, _) => Some(String::from_utf8_lossy(raw).to_string()),
            _ => None,
        },
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Sanity : PDFium chargé + extraction de texte fonctionnelle
// ---------------------------------------------------------------------------

#[test]
fn pdfium_loads_and_extracts_text() {
    let pdf = build_pdf(&[&["CONFIDENTIEL", "PUBLIC"]]);
    let text = page_text(&pdf, 1);
    // Si PDFium n'était pas chargé, l'analyse retournerait un texte vide et ce
    // test échouerait bruyamment (au lieu de laisser passer un faux positif).
    assert!(
        text.contains("CONFIDENTIEL"),
        "PDFium devrait extraire le texte, obtenu: {text:?}"
    );
    assert!(text.contains("PUBLIC"), "obtenu: {text:?}");
}

// ---------------------------------------------------------------------------
// Caviardage : le texte doit RÉELLEMENT disparaître
// ---------------------------------------------------------------------------

#[test]
fn auto_redact_removes_only_the_targeted_text() {
    let input = build_pdf(&[&["CONFIDENTIEL", "PUBLIC"]]);
    let input_clone = input.clone();

    let (out, count) =
        pdf_tools::auto_redact(&input, &["CONFIDENTIEL".to_string()], false).expect("redact");

    assert!(count >= 1, "au moins une occurrence caviardée");
    assert_eq!(input, input_clone, "le fichier source ne doit jamais muter");

    let text = page_text(&out, 1);
    assert!(
        !text.contains("CONFIDENTIEL"),
        "le texte caviardé ne doit plus être extractible, obtenu: {text:?}"
    );
    assert!(
        text.contains("PUBLIC"),
        "le texte non visé doit subsister, obtenu: {text:?}"
    );
    assert_eq!(page_count(&out), 1);
}

#[test]
fn redact_full_area_makes_text_unextractable() {
    let input = build_pdf(&[&["TOPSECRET"]]);
    // Zone couvrant toute la page A4 (repère haut-gauche, points).
    let areas = [(1u32, (0.0_f64, 0.0_f64, 595.0_f64, 842.0_f64))];

    let outcome = pdf_edit::redact(&input, &areas, false).expect("redact area");
    assert!(outcome.removed_text_blocks >= 1, "un run texte supprimé");

    let text = page_text(&outcome.bytes, 1);
    assert!(
        !text.contains("TOPSECRET"),
        "le texte sous le caviardage doit disparaître, obtenu: {text:?}"
    );
}

// ---------------------------------------------------------------------------
// Opérations de page
// ---------------------------------------------------------------------------

#[test]
fn delete_pages_reduces_count() {
    let input = build_pdf(&[&["ALPHA"], &["BETA"], &["GAMMA"]]);
    assert_eq!(page_count(&input), 3);

    let out = pdf_ops::delete_pages(input, vec![2]).expect("delete");
    assert_eq!(page_count(&out), 2);

    let remaining = format!("{} {}", page_text(&out, 1), page_text(&out, 2));
    assert!(remaining.contains("ALPHA") && remaining.contains("GAMMA"));
    assert!(!remaining.contains("BETA"), "la page supprimée doit partir");
}

#[test]
fn extract_pages_keeps_only_listed() {
    let input = build_pdf(&[&["ALPHA"], &["BETA"], &["GAMMA"]]);
    let out = pdf_ops::extract_pages(input, vec![2]).expect("extract");
    assert_eq!(page_count(&out), 1);
    assert!(page_text(&out, 1).contains("BETA"));
}

#[test]
fn reorder_pages_changes_order() {
    let input = build_pdf(&[&["ALPHA"], &["BETA"], &["GAMMA"]]);
    let out = pdf_ops::reorder_pages(input, vec![3, 1, 2]).expect("reorder");
    assert_eq!(page_count(&out), 3);
    assert!(
        page_text(&out, 1).contains("GAMMA"),
        "la 1re page doit être l'ancienne page 3"
    );
}

#[test]
fn rotate_pages_sets_rotation_angle() {
    let input = build_pdf(&[&["ALPHA"]]);
    assert_eq!(page_rotation(&input, 1), 0);

    let out = pdf_ops::rotate_pages(input, vec![1], 90).expect("rotate");
    assert_eq!(page_rotation(&out, 1), 90);
}

#[test]
fn merge_pdfs_concatenates_pages() {
    let a = build_pdf(&[&["ALPHA"]]);
    let b = build_pdf(&[&["BETA"], &["GAMMA"]]);
    let out = pdf_ops::merge_pdfs(vec![a, b]).expect("merge");
    assert_eq!(page_count(&out), 3);
}

// ---------------------------------------------------------------------------
// Métadonnées
// ---------------------------------------------------------------------------

#[test]
fn set_metadata_updates_title_only() {
    let input = build_pdf(&[&["ALPHA"]]);
    let out = pdf_edit::set_metadata(&input, Some("Mon Titre"), None, None, None).expect("metadata");
    assert_eq!(info_title(&out).as_deref(), Some("Mon Titre"));
    // Le contenu reste intact.
    assert_eq!(page_count(&out), 1);
    assert!(page_text(&out, 1).contains("ALPHA"));
}

// ---------------------------------------------------------------------------
// Robustesse : un PDF invalide remonte une erreur, jamais un panic
// ---------------------------------------------------------------------------

#[test]
fn invalid_pdf_returns_error_not_panic() {
    let garbage = b"this is definitely not a pdf".to_vec();

    assert!(pdf_engine::analyze_pdf_page(&garbage, 1).is_err());
    assert!(pdf_ops::delete_pages(garbage.clone(), vec![1]).is_err());
    assert!(pdf_ops::merge_pdfs(vec![garbage.clone()]).is_err());
    assert!(pdf_tools::auto_redact(&garbage, &["x".to_string()], false).is_err());
}

#[test]
fn redact_with_no_areas_errors() {
    let input = build_pdf(&[&["ALPHA"]]);
    assert!(pdf_edit::redact(&input, &[], false).is_err());
}
