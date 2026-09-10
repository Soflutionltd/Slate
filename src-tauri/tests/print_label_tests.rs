//! Tests d'intégration du recadrage d'étiquette (`print_layout::fit_label_to_media`).
//!
//! Le cas de référence est une étiquette d'expédition 110 × 210 mm imprimée sur
//! du thermique 4×6 pouces (288 × 432 pt), qui est le format des étiquettes DHL
//! Express. On vérifie surtout deux choses :
//!   - la page de sortie fait exactement la taille du media ;
//!   - le contenu n'est jamais déformé (échelle uniforme, ratio préservé).
//!
//! PDFium est nécessaire pour l'analyse du contenu : il est chargé depuis
//! `CARGO_MANIFEST_DIR`, où `libpdfium.dylib` est présent en dev/CI.

use lopdf::{Document, Object};
use sofdocs_desktop::pdf_label::analyze_label_page;
use sofdocs_desktop::print_layout::{fit_label_to_media, LabelTarget};

/// 110 × 210 mm en points PostScript.
const LABEL_110X210: (f32, f32) = (311.81, 595.28);
/// 4×6 pouces en points.
const MEDIA_4X6: (f64, f64) = (288.0, 432.0);

/// Construit une étiquette 110 × 210 mm avec des marges blanches et des bandes
/// vides internes, comme un vrai label d'expédition.
///
/// `blocks` décrit les blocs de contenu en points depuis le BAS de la page :
/// `(y0, y1)`. Entre deux blocs, la page est vide.
fn build_label(blocks: &[(f32, f32)], left: f32, right: f32) -> Vec<u8> {
    let (width, height) = LABEL_110X210;
    let mut content = String::from("0 g\n");
    for (y0, y1) in blocks {
        // Rectangle plein : garantit de l'encre sur toute la hauteur du bloc.
        content.push_str(&format!(
            "{} {} {} {} re f\n",
            left,
            y0,
            right - left,
            y1 - y0
        ));
    }

    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_string(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents 4 0 R >>"
        ),
        format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            content.len(),
            content
        ),
    ];

    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in &offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            objects.len() + 1,
            xref
        )
        .as_bytes(),
    );
    pdf
}

/// Étiquette de référence : marges de ~10 pt, cinq blocs séparés par des
/// gouttières de 24 pt (≈ 8,5 mm), comme un label DHL.
fn reference_label() -> Vec<u8> {
    build_label(
        &[
            (14.0, 100.0),
            (124.0, 210.0),
            (234.0, 320.0),
            (344.0, 430.0),
            (454.0, 580.0),
        ],
        10.0,
        300.0,
    )
}

fn page_media_box(pdf: &[u8]) -> (f64, f64) {
    let doc = Document::load_mem(pdf).expect("relecture du PDF produit");
    let page_id = *doc
        .get_pages()
        .values()
        .next()
        .expect("le PDF produit doit avoir une page");
    let media = doc
        .get_dictionary(page_id)
        .expect("dictionnaire de page")
        .get(b"MediaBox")
        .expect("MediaBox présent")
        .as_array()
        .expect("MediaBox est un tableau")
        .iter()
        .map(|value| match value {
            Object::Integer(i) => *i as f64,
            Object::Real(r) => *r as f64,
            other => panic!("MediaBox non numérique : {other:?}"),
        })
        .collect::<Vec<f64>>();
    ((media[2] - media[0]).abs(), (media[3] - media[1]).abs())
}

/// Lit les matrices `a b c d e f cm` du flux de la page produite.
fn content_matrices(pdf: &[u8]) -> Vec<[f64; 6]> {
    let doc = Document::load_mem(pdf).expect("relecture");
    let page_id = *doc.get_pages().values().next().expect("une page");
    let stream = doc.get_page_content(page_id).expect("flux de page");
    let text = String::from_utf8_lossy(&stream).to_string();
    let mut matrices = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(values) = line.strip_suffix(" cm") else {
            continue;
        };
        let parsed: Vec<f64> = values
            .split_whitespace()
            .filter_map(|token| token.parse::<f64>().ok())
            .collect();
        if parsed.len() == 6 {
            matrices.push([
                parsed[0], parsed[1], parsed[2], parsed[3], parsed[4], parsed[5],
            ]);
        }
    }
    matrices
}

#[test]
fn output_page_matches_target_media_exactly() {
    let fitted = fit_label_to_media(
        &reference_label(),
        &LabelTarget {
            width_pt: MEDIA_4X6.0,
            height_pt: MEDIA_4X6.1,
            margin_pt: 0.0,
            gutter_pt: 6.0,
        },
    )
    .expect("recadrage");

    let (width, height) = page_media_box(&fitted.bytes);
    assert!(
        (width - 288.0).abs() < 0.01,
        "largeur attendue 288 pt, obtenue {width}"
    );
    assert!(
        (height - 432.0).abs() < 0.01,
        "hauteur attendue 432 pt, obtenue {height}"
    );
}

#[test]
fn content_is_never_distorted() {
    let fitted = fit_label_to_media(
        &reference_label(),
        &LabelTarget {
            width_pt: MEDIA_4X6.0,
            height_pt: MEDIA_4X6.1,
            margin_pt: 0.0,
            gutter_pt: 6.0,
        },
    )
    .expect("recadrage");

    let matrices = content_matrices(&fitted.bytes);
    assert!(!matrices.is_empty(), "aucune matrice dans le flux produit");
    for [a, b, c, d, _, _] in matrices {
        // Pas de cisaillement.
        assert!(b.abs() < 1e-6 && c.abs() < 1e-6, "matrice cisaillée : {b} {c}");
        // Échelle identique sur les deux axes, à 0,5 % près.
        let ratio = (a / d).abs();
        assert!(
            (ratio - 1.0).abs() <= 0.005,
            "contenu déformé : sx={a}, sy={d}, rapport {ratio}"
        );
    }
}

#[test]
fn scale_never_exceeds_one_hundred_percent() {
    // Étiquette plus petite que le media : ne doit pas être agrandie.
    let small = build_label(&[(20.0, 120.0)], 20.0, 150.0);
    let fitted = fit_label_to_media(
        &small,
        &LabelTarget {
            width_pt: MEDIA_4X6.0,
            height_pt: MEDIA_4X6.1,
            margin_pt: 0.0,
            gutter_pt: 6.0,
        },
    )
    .expect("recadrage");
    assert!(
        fitted.scale <= 1.0 + 1e-9,
        "échelle {} : le contenu a été agrandi",
        fitted.scale
    );
    for [a, _, _, _, _, _] in content_matrices(&fitted.bytes) {
        assert!(a <= 1.0 + 1e-6, "matrice agrandissante : {a}");
    }
}

#[test]
fn compacting_gutters_beats_plain_crop_which_beats_raw_scaling() {
    let label = reference_label();
    let base = LabelTarget {
        width_pt: MEDIA_4X6.0,
        height_pt: MEDIA_4X6.1,
        margin_pt: 0.0,
        gutter_pt: 0.0,
    };
    let cropped = fit_label_to_media(&label, &base).expect("recadrage simple");
    let compacted = fit_label_to_media(
        &label,
        &LabelTarget {
            gutter_pt: 6.0,
            ..base
        },
    )
    .expect("recadrage compacté");

    // Sans rien faire, la page entière tombe à 432/595,28 ≈ 72,6 %.
    let raw = (MEDIA_4X6.1 / LABEL_110X210.1 as f64).min(MEDIA_4X6.0 / LABEL_110X210.0 as f64);
    assert!(
        cropped.scale > raw,
        "le recadrage doit faire mieux que la mise à l'échelle brute : {} vs {raw}",
        cropped.scale
    );
    assert!(
        compacted.scale > cropped.scale,
        "le resserrage doit faire mieux que le recadrage seul : {} vs {}",
        compacted.scale,
        cropped.scale
    );
    assert!(
        compacted.compacted_gutters >= 4,
        "quatre gouttières attendues, {} resserrées",
        compacted.compacted_gutters
    );
}

#[test]
fn report_exposes_source_dimensions() {
    let fitted = fit_label_to_media(
        &reference_label(),
        &LabelTarget {
            width_pt: MEDIA_4X6.0,
            height_pt: MEDIA_4X6.1,
            margin_pt: 0.0,
            gutter_pt: 6.0,
        },
    )
    .expect("recadrage");
    assert!((fitted.source_width_pt - LABEL_110X210.0 as f64).abs() < 0.5);
    assert!((fitted.source_height_pt - LABEL_110X210.1 as f64).abs() < 0.5);
}

#[test]
fn margin_is_respected_on_all_sides() {
    let fitted = fit_label_to_media(
        &reference_label(),
        &LabelTarget {
            width_pt: MEDIA_4X6.0,
            height_pt: MEDIA_4X6.1,
            margin_pt: 12.0,
            gutter_pt: 6.0,
        },
    )
    .expect("recadrage");
    // Le contenu le plus haut est calé sous la marge supérieure.
    let matrices = content_matrices(&fitted.bytes);
    let highest = matrices
        .iter()
        .map(|matrix| matrix[5])
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(
        highest.is_finite(),
        "aucune translation verticale trouvée dans {matrices:?}"
    );
    // La sortie reste bien à la taille du media, marge comprise.
    let (width, height) = page_media_box(&fitted.bytes);
    assert!((width - 288.0).abs() < 0.01 && (height - 432.0).abs() < 0.01);
}

#[test]
fn analysis_finds_margins_and_gutters() {
    let label = reference_label();
    let layout = analyze_label_page(&label, 1, 72.0, 8.0).expect("analyse");
    assert!(
        (layout.page_width - LABEL_110X210.0).abs() < 0.5,
        "largeur de page {}",
        layout.page_width
    );
    // Les blocs de la référence sont séparés par 24 pt de vide.
    assert_eq!(
        layout.bands.len(),
        5,
        "cinq blocs attendus, obtenu {:?}",
        layout.bands
    );
    // Le contenu ne couvre pas toute la page : les marges ont été détectées.
    assert!(
        layout.content.width() < LABEL_110X210.0,
        "bbox large de {} sur une page de {}",
        layout.content.width(),
        LABEL_110X210.0
    );
    // Les blocs montent du bas vers le haut.
    for pair in layout.bands.windows(2) {
        assert!(pair[0].y0 < pair[1].y0, "blocs mal ordonnés : {:?}", layout.bands);
    }
}

#[test]
fn invalid_targets_are_rejected() {
    let label = reference_label();
    assert!(fit_label_to_media(
        &label,
        &LabelTarget {
            width_pt: 0.0,
            height_pt: 432.0,
            margin_pt: 0.0,
            gutter_pt: 0.0,
        }
    )
    .is_err());
    // Marge plus grande que le media.
    assert!(fit_label_to_media(
        &label,
        &LabelTarget {
            width_pt: 288.0,
            height_pt: 432.0,
            margin_pt: 200.0,
            gutter_pt: 0.0,
        }
    )
    .is_err());
}

#[test]
fn invalid_pdf_never_panics() {
    let result = fit_label_to_media(
        b"pas du tout un PDF",
        &LabelTarget {
            width_pt: 288.0,
            height_pt: 432.0,
            margin_pt: 0.0,
            gutter_pt: 6.0,
        },
    );
    assert!(result.is_err());
}
