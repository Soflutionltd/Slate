// Outil de diagnostic : dump des blocs éditables produits par analyze_pdf_page.
// Usage : cargo run --example blockdbg -- "/chemin/doc.pdf" [page]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("chemin du PDF requis");
    let page_number: u32 = args.get(2).map(|p| p.parse().unwrap_or(1)).unwrap_or(1);

    let bytes = std::fs::read(path).expect("lecture du PDF");
    let analysis = sofdocs_desktop::pdf_engine::analyze_pdf_page(&bytes, page_number)
        .expect("analyse de la page");

    println!(
        "=== Page {page_number} — {} blocs (moteur {}) ===",
        analysis.blocks.len(),
        analysis.engine
    );
    for block in &analysis.blocks {
        println!(
            "{} kind={} x={:7.1} y={:7.1} w={:7.1} h={:7.1} chars={} {:?}",
            block.id,
            block.kind,
            block.x,
            block.y,
            block.width,
            block.height,
            block.chars.len(),
            block.text.chars().take(40).collect::<String>()
        );
    }
}
