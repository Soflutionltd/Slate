// Test E2E des nouvelles fonctions pdf_tools (inspirées de Stirling PDF).
// Usage : cargo run --example tools_e2e

use image::{Rgb, RgbImage};
use pdfium_render::prelude::*;
use sofdocs_desktop::{pdf_engine, pdf_tools};

fn main() {
    let dir = std::env::temp_dir().join("alto-tools-e2e");
    std::fs::create_dir_all(&dir).expect("temp dir");

    let source = build_sample_pdf();
    println!("Source: {} octets", source.len());

    // 1) Filigrane
    let wm = pdf_tools::watermark_text(&source, "CONFIDENTIEL", 60.0, 0.25, 45.0, Some([200, 0, 0]), true)
        .expect("watermark");
    save(&dir, "01-filigrane.pdf", &wm);
    assert!(extract_text(&wm).contains("CONFIDENTIEL"));
    println!("1. watermark_text OK");

    // 2) Numéros de page
    let pn = pdf_tools::add_page_numbers(&source, "bottom-center", 1, 11.0, 28.0).expect("page numbers");
    save(&dir, "02-numeros.pdf", &pn);
    let pn_text = extract_text(&pn);
    assert!(pn_text.contains('1') && pn_text.contains('2'));
    println!("2. add_page_numbers OK");

    // 3) Images -> PDF
    let mut img1 = Vec::new();
    image::DynamicImage::ImageRgb8(RgbImage::from_pixel(400, 300, Rgb([10, 120, 200])))
        .write_to(&mut std::io::Cursor::new(&mut img1), image::ImageFormat::Png)
        .unwrap();
    let mut img2 = Vec::new();
    image::DynamicImage::ImageRgb8(RgbImage::from_pixel(300, 500, Rgb([200, 120, 10])))
        .write_to(&mut std::io::Cursor::new(&mut img2), image::ImageFormat::Jpeg)
        .unwrap();
    let pdf_from_imgs = pdf_tools::images_to_pdf(vec![img1, img2]).expect("images_to_pdf");
    save(&dir, "03-images.pdf", &pdf_from_imgs);
    assert_eq!(page_count(&pdf_from_imgs), 2);
    println!("3. images_to_pdf OK (2 pages)");

    // 4) Rogner
    let cropped = pdf_tools::crop_pages(&source, 40.0, 40.0, 40.0, 40.0).expect("crop");
    save(&dir, "04-rogne.pdf", &cropped);
    println!("4. crop_pages OK");

    // 5) Aplatir
    let flat = pdf_tools::flatten(&source).expect("flatten");
    save(&dir, "05-aplati.pdf", &flat);
    println!("5. flatten OK");

    // 6) Extraire les images (sur le PDF construit depuis des images)
    let extracted = pdf_tools::extract_images(&pdf_from_imgs).expect("extract images");
    assert_eq!(extracted.len(), 2, "2 images attendues");
    for img in &extracted {
        assert!(img.png.starts_with(&[0x89, b'P', b'N', b'G']), "PNG valide");
        save(&dir, &format!("06-image-p{}-{}.png", img.page, img.index), &img.png);
    }
    println!("6. extract_images OK ({} images)", extracted.len());

    // 7) Caviardage auto
    let (redacted, hits) = pdf_tools::auto_redact(&source, &["Dupont".to_string()], false)
        .expect("auto_redact");
    assert!(hits >= 1, "au moins 1 occurrence caviardée");
    save(&dir, "07-caviarde.pdf", &redacted);
    assert!(!extract_text(&redacted).contains("Dupont"), "texte non récupérable");
    println!("7. auto_redact OK ({hits} occurrence(s))");

    // 8) Sanitize
    let sanitized = pdf_tools::sanitize(&source).expect("sanitize");
    save(&dir, "08-sanitize.pdf", &sanitized);
    assert_eq!(page_count(&sanitized), page_count(&source), "pages préservées");
    println!("8. sanitize OK");

    // 9) Déverrouiller : on protège d'abord, puis on retire le mot de passe
    let protected = sofdocs_desktop::pdf_ops::encrypt_pdf(source.clone(), "secret123".into(), Some("secret123".into()))
        .expect("encrypt");
    let unlocked = pdf_tools::remove_password(&protected, "secret123").expect("remove_password");
    save(&dir, "09-deverrouille.pdf", &unlocked);
    // Le PDF déverrouillé se relit sans mot de passe.
    assert!(page_count(&unlocked) >= 1);
    println!("9. remove_password OK");

    // 10) Marque-pages
    let items = vec![
        pdf_tools::BookmarkItem { title: "Couverture".into(), page: 1 },
        pdf_tools::BookmarkItem { title: "Annexe".into(), page: 2 },
    ];
    let with_bm = pdf_tools::set_bookmarks(&source, &items).expect("set_bookmarks");
    save(&dir, "10-marque-pages.pdf", &with_bm);
    let read_back = pdf_tools::get_bookmarks(&with_bm).expect("get_bookmarks");
    assert!(read_back.iter().any(|b| b.title == "Couverture"), "marque-page relu");
    println!("10. bookmarks OK ({} relus)", read_back.len());

    println!("\nTous les tests pdf_tools passent. Fichiers dans {}", dir.display());
}

fn build_sample_pdf() -> Vec<u8> {
    let guard = pdf_engine::pdfium_guard().expect("pdfium");
    let mut document = guard.create_new_pdf().expect("new pdf");
    let helvetica = document.fonts_mut().helvetica();
    for (title, body) in [
        ("Contrat", "Client : Jean Dupont"),
        ("Annexe", "Page deux du document"),
    ] {
        let mut page = document
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::a4())
            .expect("page");
        let objects = page.objects_mut();
        objects
            .create_text_object(PdfPoints::new(72.0), PdfPoints::new(760.0), title, helvetica, PdfPoints::new(20.0))
            .expect("title");
        objects
            .create_text_object(PdfPoints::new(72.0), PdfPoints::new(720.0), body, helvetica, PdfPoints::new(12.0))
            .expect("body");
        page.regenerate_content().expect("regen");
    }
    document.save_to_bytes().expect("save")
}

fn extract_text(bytes: &[u8]) -> String {
    let guard = pdf_engine::pdfium_guard().expect("pdfium");
    let document = guard.load_pdf_from_byte_slice(bytes, None).expect("load");
    let mut out = String::new();
    for page in document.pages().iter() {
        out.push_str(&page.text().expect("text").all());
        out.push('\n');
    }
    out
}

fn page_count(bytes: &[u8]) -> usize {
    let guard = pdf_engine::pdfium_guard().expect("pdfium");
    let document = guard.load_pdf_from_byte_slice(bytes, None).expect("load");
    document.pages().len() as usize
}

fn save(dir: &std::path::Path, name: &str, bytes: &[u8]) {
    std::fs::write(dir.join(name), bytes).expect("write output");
}
