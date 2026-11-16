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
fn rotate_pages_180_turns_upside_down() {
    let input = build_pdf(&[&["ALPHA"]]);
    let out = pdf_ops::rotate_pages(input, vec![1], 180).expect("rotate");
    assert_eq!(page_rotation(&out, 1), 180);
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

#[test]
fn save_check_refuses_a_pdf_that_does_not_reopen() {
    let pdf = build_pdf(&[&["ALPHA"]]);
    assert!(pdf_engine::check_pdf_reopens(&pdf).is_ok());

    let truncated = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog".to_vec();
    let err = pdf_engine::check_pdf_reopens(&truncated).unwrap_err();
    assert!(err.starts_with("save_does_not_reopen"), "obtenu: {err}");

    // Une image exportée n'est pas un PDF : elle n'est pas contrôlée.
    assert!(pdf_engine::check_pdf_reopens(b"\x89PNG\r\n\x1a\n").is_ok());
}

fn predictor_stream(params: lopdf::Dictionary) -> Stream {
    let mut stream = Stream::new(dictionary! {}, vec![0u8; 4096]);
    stream.compress().unwrap();
    stream.dict.set("DecodeParms", params);
    stream
}

#[test]
fn png_predictor_refuses_rows_longer_than_the_data() {
    let hostile = predictor_stream(dictionary! { "Predictor" => 12, "Columns" => 4_294_967_295i64 });
    assert!(hostile.decompressed_content().is_err());

    let overflow = predictor_stream(dictionary! {
        "Predictor" => 12,
        "Columns" => 2,
        "Colors" => i64::MAX,
        "BitsPerComponent" => 16,
    });
    assert!(overflow.decompressed_content().is_err());

    // 4096 octets = 1024 lignes de (1 octet de filtre + 3 colonnes).
    let valid = predictor_stream(dictionary! { "Predictor" => 12, "Columns" => 3 });
    assert_eq!(valid.decompressed_content().unwrap(), vec![0u8; 3072]);
}

/// Page 200×100 pt : aplat rouge (contenu), puis trois carrés noirs dessinés par
/// leur apparence : un champ texte, un bouton poussoir, une annotation carrée.
fn build_view_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let page_id = doc.new_object_id();
    let black_square = |doc: &mut Document| {
        doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 30.into(), 30.into()],
            },
            b"0 0 0 rg 0 0 30 30 re f".to_vec(),
        ))
    };
    let rect = |x: i64| vec![x.into(), 10.into(), (x + 30).into(), 40.into()];
    let text_ap = black_square(&mut doc);
    let text_field = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("nom"),
        "Rect" => rect(60), "F" => 4, "P" => page_id, "AP" => dictionary! { "N" => text_ap },
    });
    let button_ap = black_square(&mut doc);
    let button = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Btn", "Ff" => 65536,
        "T" => Object::string_literal("ok"),
        "Rect" => rect(110), "F" => 4, "P" => page_id, "AP" => dictionary! { "N" => button_ap },
    });
    let square_ap = black_square(&mut doc);
    let square = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Square",
        "Rect" => rect(160), "F" => 4, "P" => page_id, "AP" => dictionary! { "N" => square_ap },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"1 0 0 rg 10 10 30 30 re f".to_vec()));
    doc.objects.insert(
        page_id,
        Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            "Annots" => vec![text_field.into(), button.into(), square.into()],
        }),
    );
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => pages_id,
        "AcroForm" => dictionary! { "Fields" => vec![text_field.into(), button.into()] },
    });
    doc.trailer.set("Root", catalog_id);
    let mut buf = Vec::new();
    doc.save_to(&mut Cursor::new(&mut buf)).expect("save pdf");
    buf
}

#[test]
fn view_render_is_exact_rgba_without_html_form_fields() {
    let pdf = build_view_pdf();
    // Canvas plus étroit et plus haut que la page à l'échelle 2 (400×200) :
    // recadrage à droite, marge blanche en bas, jamais d'étirement.
    let (width, height) = (380u32, 210u32);
    let rgba = pdf_engine::render_page_rgba_for_view(&pdf, 1, 2.0, width, height).unwrap();
    assert_eq!(rgba.len(), (width * height * 4) as usize);
    let pixel = |x: u32, y: u32| {
        let at = ((y * width + x) * 4) as usize;
        [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
    };
    // Points → pixels (×2, axe vertical inversé) : centre de chaque carré à y = 150 px.
    assert_eq!(pixel(50, 150), [255, 0, 0, 255], "aplat rouge en RGBA");
    assert_eq!(pixel(150, 150), [255, 255, 255, 255], "champ texte laissé à la couche HTML");
    assert_eq!(pixel(250, 150)[..3], [0, 0, 0], "bouton poussoir peint");
    assert_eq!(pixel(350, 150)[..3], [0, 0, 0], "annotation peinte");
    // Bord gauche de l'aplat exactement à 20 px (10 pt × 2) : rien n'a glissé.
    assert_eq!(pixel(19, 150), [255, 255, 255, 255]);
    assert_eq!(pixel(20, 150), [255, 0, 0, 255]);
    assert_eq!(pixel(50, 205), [255, 255, 255, 255], "marge sous la page");

    // Témoin : le rendu complet peint bien le champ texte (le test n'est pas vide).
    let (png, _, _) = pdf_engine::render_pdf_page_png_bytes(&pdf, 1, 2.0).unwrap();
    let full = image::load_from_memory(&png).unwrap().to_rgba8();
    assert_eq!(full.get_pixel(150, 150).0[..3], [0, 0, 0]);

    assert!(pdf_engine::render_page_rgba_for_view(&pdf, 1, 2.0, 0, 10).is_err());
    assert!(pdf_engine::render_page_rgba_for_view(&pdf, 1, 0.0, 10, 10).is_err());
    assert!(pdf_engine::render_page_rgba_for_view(&pdf, 2, 2.0, 10, 10).is_err());
}

// ---------------------------------------------------------------------------
// Formes vectorielles : détection et suppression
// ---------------------------------------------------------------------------

/// Page A4 avec un bandeau gris sous un titre, un filet fin et une ligne de
/// texte : le cas « barre de section » d'un compte rendu.
fn build_banner_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    });
    let content = b"0.85 g\n72 700 451 20 re\nf\n0 g\n0.4 G\n0.75 w\n72 650 m\n372 650 l\nS\n\
BT /F1 12 Tf 250 706 Td (Microbiologie) Tj ET\n\
BT /F1 12 Tf 72 620 Td (Resultat negatif) Tj ET\n";
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let pages_id = doc.new_object_id();
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
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::from(page_id)],
            "Count" => 1,
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

/// Formes de la page 1, telles que l'éditeur les reçoit puis les renvoie au moteur.
fn page_shapes(bytes: &[u8]) -> Vec<pdf_edit::ShapeTarget> {
    pdf_engine::analyze_pdf_page(bytes, 1)
        .expect("analyze page")
        .blocks
        .iter()
        .filter(|block| block.kind == "shape")
        .map(|block| pdf_edit::ShapeTarget {
            index: block.id.rsplit('-').next().unwrap().parse().unwrap(),
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
        })
        .collect()
}

#[test]
fn analysis_reports_visible_shapes_as_blocks() {
    let pdf = build_banner_pdf();
    let shapes = page_shapes(&pdf);
    assert_eq!(shapes.len(), 2, "bandeau + filet attendus : {shapes:?}");
    let banner = shapes.iter().find(|s| s.height > 10.0).expect("bandeau");
    assert!((banner.width - 451.0).abs() < 1.0 && (banner.height - 20.0).abs() < 1.0);
    // Origine en haut à gauche : 842 - (700 + 20).
    assert!((banner.x - 72.0).abs() < 1.0 && (banner.y - 122.0).abs() < 1.0);
    let rule = shapes.iter().find(|s| s.height <= 2.0).expect("filet");
    // PDFium compte l'épaisseur du trait (0,75 pt) à chaque extrémité.
    assert!((rule.width - 301.5).abs() < 0.5, "largeur du filet : {}", rule.width);
}

#[test]
fn delete_shapes_removes_only_the_targeted_shape() {
    let pdf = build_banner_pdf();
    let shapes = page_shapes(&pdf);
    let banner = shapes.iter().find(|s| s.height > 10.0).unwrap().clone();

    let out = pdf_edit::delete_shapes(&pdf, 1, &[banner]).expect("delete banner");

    let left = page_shapes(&out);
    assert_eq!(left.len(), 1, "seul le filet doit rester : {left:?}");
    assert!(left[0].height <= 2.0);
    let text = page_text(&out, 1);
    assert!(text.contains("Microbiologie") && text.contains("Resultat negatif"), "texte intact : {text}");
}

#[test]
fn delete_shapes_finds_the_shape_by_bounds_when_the_index_is_stale() {
    let pdf = build_banner_pdf();
    let shapes = page_shapes(&pdf);
    let banner = shapes.iter().find(|s| s.height > 10.0).unwrap().clone();
    let rule = shapes.iter().find(|s| s.height <= 2.0).unwrap().clone();
    // Index du filet, boîte du bandeau : c'est le bandeau qui doit partir.
    let stale = pdf_edit::ShapeTarget { index: rule.index, ..banner };

    let out = pdf_edit::delete_shapes(&pdf, 1, &[stale]).expect("delete by bounds");

    let left = page_shapes(&out);
    assert_eq!(left.len(), 1);
    assert!(left[0].height <= 2.0, "le filet doit rester : {left:?}");
}

#[test]
fn delete_shapes_refuses_an_unknown_shape_and_a_text_object() {
    let pdf = build_banner_pdf();
    let nowhere = pdf_edit::ShapeTarget { index: 0, x: 300.0, y: 400.0, width: 50.0, height: 50.0 };
    assert!(pdf_edit::delete_shapes(&pdf, 1, &[nowhere]).is_err());

    // Boîte d'un bloc texte : ce n'est pas un tracé, rien ne doit être retiré.
    let analysis = pdf_engine::analyze_pdf_page(&pdf, 1).expect("analyze page");
    let text = analysis.blocks.iter().find(|b| b.kind == "text").expect("text block");
    let as_shape = pdf_edit::ShapeTarget { index: 2, x: text.x, y: text.y, width: text.width, height: text.height };
    assert!(pdf_edit::delete_shapes(&pdf, 1, &[as_shape]).is_err());
    assert!(pdf_edit::delete_shapes(&pdf, 1, &[]).is_err());
}
