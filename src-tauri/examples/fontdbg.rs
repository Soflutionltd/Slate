use pdfium_render::prelude::*;

fn main() {
    let lib = "/Applications/Alto PDF.app/Contents/Resources/libpdfium.dylib";
    let bindings = match Pdfium::bind_to_library(lib) {
        Ok(b) => {
            eprintln!("DYLIB LOADED OK from {lib}");
            b
        }
        Err(e) => {
            eprintln!("DYLIB LOAD FAILED: {e}");
            return;
        }
    };
    let pdfium = Pdfium::new(bindings);
    let bytes = std::fs::read("/tmp/devis.pdf").unwrap();
    let document = pdfium.load_pdf_from_byte_slice(&bytes, None).unwrap();
    let page = document.pages().get(0).unwrap();
    let text = page.text().unwrap();
    for segment in text.segments().iter() {
        let content = segment.text();
        let trimmed = content.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut name = String::new();
        if let Ok(chars) = segment.chars() {
            for ch in chars.iter() {
                if ch.unicode_char().unwrap_or(' ').is_whitespace() {
                    continue;
                }
                name = ch.font_name();
                break;
            }
        }
        let low = name.to_lowercase();
        let bold = low.contains("bold")
            || low.contains("black")
            || low.contains("heavy")
            || low.contains("semibold");
        println!("bold={} name={} text={}", bold, name, trimmed);
    }
}
