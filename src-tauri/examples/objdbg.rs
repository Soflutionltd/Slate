// Outil de diagnostic : dump des objets d'une page PDF (type, bornes, texte).
// Usage : cargo run --example objdbg -- "/chemin/doc.pdf" [page]
use pdfium_render::prelude::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("chemin du PDF requis");
    let page_number: usize = args.get(2).map(|p| p.parse().unwrap_or(1)).unwrap_or(1);

    let lib_path = concat!(env!("CARGO_MANIFEST_DIR"), "/libpdfium.dylib");
    let bindings = Pdfium::bind_to_library(lib_path).expect("libpdfium");
    let pdfium = Pdfium::new(bindings);
    let document = pdfium.load_pdf_from_file(path, None).expect("load pdf");
    let page = document
        .pages()
        .get((page_number - 1) as i32)
        .expect("page");
    let page_height = page.height().value as f64;

    println!("=== Page {page_number} — objets ===");
    for (index, object) in page.objects().iter().enumerate() {
        let kind = object.object_type();
        let bounds = match object.bounds() {
            Ok(b) => b,
            Err(_) => {
                println!("#{index:3} {kind:?} (pas de bounds)");
                continue;
            }
        };
        let x = bounds.left().value as f64;
        let y = page_height - bounds.top().value as f64;
        let w = bounds.width().value as f64;
        let h = bounds.height().value as f64;
        let text = if kind == PdfPageObjectType::Text {
            object
                .as_text_object()
                .map(|t| t.text())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let mut color_info = String::new();
        if let Ok(fill) = object.fill_color() {
            color_info.push_str(&format!(
                " fill=({},{},{},a{})",
                fill.red(),
                fill.green(),
                fill.blue(),
                fill.alpha()
            ));
        }
        if let Ok(stroke) = object.stroke_color() {
            color_info.push_str(&format!(
                " stroke=({},{},{},a{})",
                stroke.red(),
                stroke.green(),
                stroke.blue(),
                stroke.alpha()
            ));
        }
        if let Some(path) = object.as_path_object() {
            let fill_mode = path.fill_mode();
            let stroked = path.is_stroked();
            color_info.push_str(&format!(" mode={fill_mode:?}/stroked={stroked:?}"));
        }
        println!(
            "#{index:3} {kind:?} x={x:7.1} y={y:7.1} w={w:7.1} h={h:7.1}{color_info} {text:?}"
        );
    }

    println!("\n=== Segments texte (page.text()) ===");
    let text_page = page.text().expect("text page");
    for (index, segment) in text_page.segments().iter().enumerate() {
        let bounds = segment.bounds();
        let x = bounds.left().value as f64;
        let y = page_height - bounds.top().value as f64;
        let w = bounds.width().value as f64;
        let h = bounds.height().value as f64;
        let content = segment.text();
        if y < 100.0 {
            println!("seg#{index:3} x={x:7.1} y={y:7.1} w={w:7.1} h={h:7.1} {content:?}");
        }
    }
}
