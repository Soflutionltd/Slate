//! Un document généré (Typst) reste modifiable par l'édition native : les
//! polices sont des sous-ensembles, une lettre absente passe par la police
//! de secours Liberation.

use alto_pdf_engine::pdf_engine::{analyze_pdf_page, edit_pdf_text, PdfEditBlock};
use alto_pdf_engine::pdf_generate::generate_pdf;

const QUOTE: &str = r#"#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt, lang: "fr")
= Devis 2026-014
Client : SASU Exemple

#table(columns: (1fr, auto, auto), align: (left, right, right), stroke: 0.5pt + gray, inset: 6pt,
  table.header([*Prestation*], [*Qté*], [*Prix HT*]),
  [Site vitrine], [1], [2 400 €], [Maintenance mensuelle], [12], [90 €])

Total HT : 3 480 €
"#;

fn block<'a>(blocks: &'a [PdfEditBlock], text: &str) -> &'a PdfEditBlock {
    blocks.iter().find(|b| b.text == text).unwrap_or_else(|| {
        panic!("block {text:?} not found in {:?}", blocks.iter().map(|b| &b.text).collect::<Vec<_>>())
    })
}

fn append(bytes: &[u8], target: &PdfEditBlock, inserted: &str) -> Result<Vec<String>, String> {
    let last = target.chars.last().expect("chars").page_char_index;
    let expected = format!("{}{inserted}", target.text);
    let outcome = edit_pdf_text(
        bytes,
        1,
        &[],
        last,
        -1,
        inserted,
        target.y - 4.0,
        target.height + 8.0,
        1.0,
        Some(&expected),
        Some((target.x, target.y, target.width, target.height)),
    )?;
    Ok(outcome.report.analysis.blocks.iter().map(|b| b.text.clone()).collect())
}

#[test]
fn letter_missing_from_the_subset_can_be_typed_in_a_table_cell() {
    let bytes = generate_pdf(QUOTE, Vec::new()).expect("quote compiles").bytes;
    let analysis = analyze_pdf_page(&bytes, 1).expect("analysis");
    let cell = block(&analysis.blocks, "Maintenance mensuelle");
    let blocks = append(&bytes, cell, "Z").expect("Z typed at the end of the cell");
    assert!(blocks.iter().any(|text| text == "Maintenance mensuelleZ"), "{blocks:?}");
}

#[test]
fn letter_missing_from_the_subset_can_be_typed_in_a_paragraph() {
    let bytes = generate_pdf(QUOTE, Vec::new()).expect("quote compiles").bytes;
    let analysis = analyze_pdf_page(&bytes, 1).expect("analysis");
    let line = block(&analysis.blocks, "Client : SASU Exemple");
    let blocks = append(&bytes, line, "Z").expect("Z typed at the end of the line");
    assert!(blocks.iter().any(|text| text == "Client : SASU ExempleZ"), "{blocks:?}");
}
