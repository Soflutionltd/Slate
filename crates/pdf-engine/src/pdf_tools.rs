// pdf_tools — fonctions PDF supplémentaires inspirées de Stirling PDF, bâties
// sur la stack existante (PDFium via pdfium-render + lopdf), sans nouvelle
// dépendance lourde. Toutes les fonctions sont pures : elles prennent des
// octets en entrée et renvoient de nouveaux octets (le fichier source n'est
// jamais touché ici ; l'écriture est gérée par l'appelant).
//
// Repère PDFium natif : origine en BAS à GAUCHE, Y vers le HAUT, unité points.

use pdfium_render::prelude::*;
use serde::Serialize;

use crate::pdf_engine::pdfium_guard;

fn color_from_rgb(rgb: Option<[u8; 3]>, alpha: u8) -> PdfColor {
    let [r, g, b] = rgb.unwrap_or([0, 0, 0]);
    PdfColor::new(r, g, b, alpha)
}

fn font_token(document: &mut PdfDocument, bold: bool) -> PdfFontToken {
    let fonts = document.fonts_mut();
    if bold {
        fonts.helvetica_bold()
    } else {
        fonts.helvetica()
    }
}

/// Largeur d'un texte (points) via un objet temporaire non attaché.
fn text_width(document: &PdfDocument, text: &str, font: PdfFontToken, size: f64) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    PdfPageTextObject::new(document, text, font, PdfPoints::new(size as f32))
        .ok()
        .and_then(|o| o.bounds().ok())
        .map(|b| b.width().value as f64)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Filigrane (texte)
// ---------------------------------------------------------------------------

/// Ajoute un filigrane texte répété/centré sur chaque page.
pub fn watermark_text(
    bytes: &[u8],
    text: &str,
    font_size: f64,
    opacity: f64,
    rotation_deg: f64,
    color: Option<[u8; 3]>,
    bold: bool,
) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() {
        return Err("Le texte du filigrane est vide.".into());
    }
    let guard = pdfium_guard()?;
    let document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let mut document = document;
    let alpha = ((opacity.clamp(0.05, 1.0)) * 255.0).round() as u8;
    let fill = color_from_rgb(color, alpha);
    let font = font_token(&mut document, bold);
    let theta = rotation_deg.to_radians();
    let (sin, cos) = (theta.sin(), theta.cos());

    let page_count = document.pages().len();
    for index in 0..page_count {
        let mut page = document.pages().get(index).map_err(|e| e.to_string())?;
        let pw = page.width().value as f64;
        let ph = page.height().value as f64;
        let w = text_width(&document, text, font, font_size);
        let h = font_size * 0.72;
        let (cx, cy) = (pw / 2.0, ph / 2.0);
        // Centre l'objet (origine locale en bas-gauche du texte) après rotation.
        let e = cx - (cos * (w / 2.0) - sin * (h / 2.0));
        let f = cy - (sin * (w / 2.0) + cos * (h / 2.0));

        let object = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(0.0),
                PdfPoints::new(0.0),
                text,
                font,
                PdfPoints::new(font_size as f32),
            )
            .map_err(|e| e.to_string())?;
        let mut object = object;
        object.set_fill_color(fill).map_err(|e| e.to_string())?;
        object
            .transform(
                cos as f32,
                sin as f32,
                -sin as f32,
                cos as f32,
                e as f32,
                f as f32,
            )
            .map_err(|e| e.to_string())?;
        page.regenerate_content().map_err(|e| e.to_string())?;
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Numéros de page
// ---------------------------------------------------------------------------

/// Position du numéro de page.
pub fn add_page_numbers(
    bytes: &[u8],
    position: &str,
    start_at: i64,
    font_size: f64,
    margin: f64,
) -> Result<Vec<u8>, String> {
    let guard = pdfium_guard()?;
    let mut document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let font = font_token(&mut document, false);
    let fill = PdfColor::new(60, 60, 60, 255);
    let page_count = document.pages().len();

    for index in 0..page_count {
        let label = format!("{}", start_at + index as i64);
        let mut page = document.pages().get(index).map_err(|e| e.to_string())?;
        let pw = page.width().value as f64;
        let ph = page.height().value as f64;
        let w = text_width(&document, &label, font, font_size);

        let x = match position {
            p if p.ends_with("left") => margin,
            p if p.ends_with("right") => pw - margin - w,
            // center par défaut
            _ => (pw - w) / 2.0,
        };
        let y = if position.starts_with("top") {
            ph - margin - font_size
        } else {
            margin
        };

        let object = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(x as f32),
                PdfPoints::new(y as f32),
                &label,
                font,
                PdfPoints::new(font_size as f32),
            )
            .map_err(|e| e.to_string())?;
        let mut object = object;
        object.set_fill_color(fill).map_err(|e| e.to_string())?;
        page.regenerate_content().map_err(|e| e.to_string())?;
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Images -> PDF
// ---------------------------------------------------------------------------

/// Crée un PDF à partir d'images (une image par page, page à la taille de
/// l'image en points : 1 px = 0,75 pt, soit 96 dpi).
pub fn images_to_pdf(images: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
    if images.is_empty() {
        return Err("Aucune image fournie.".into());
    }
    let guard = pdfium_guard()?;
    let mut document = guard.create_new_pdf().map_err(|e| e.to_string())?;

    for (i, raw) in images.iter().enumerate() {
        let image = image::load_from_memory(raw)
            .map_err(|e| format!("Image {} illisible : {e}", i + 1))?;
        let pw = (image.width() as f64 * 0.75).max(1.0);
        let ph = (image.height() as f64 * 0.75).max(1.0);
        let mut page = document
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::from_points(
                PdfPoints::new(pw as f32),
                PdfPoints::new(ph as f32),
            ))
            .map_err(|e| e.to_string())?;
        page.objects_mut()
            .create_image_object(
                PdfPoints::new(0.0),
                PdfPoints::new(0.0),
                &image,
                Some(PdfPoints::new(pw as f32)),
                Some(PdfPoints::new(ph as f32)),
            )
            .map_err(|e| e.to_string())?;
        page.regenerate_content().map_err(|e| e.to_string())?;
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Déverrouiller (retirer le mot de passe)
// ---------------------------------------------------------------------------

pub fn remove_password(bytes: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let guard = pdfium_guard()?;
    let source = guard
        .load_pdf_from_byte_slice(bytes, Some(password))
        .map_err(|_| "Mot de passe incorrect ou PDF illisible.".to_string())?;
    // Sauvegarder tel quel conserverait le chiffrement : on recopie les pages
    // dans un document vierge (donc sans handler de sécurité).
    let mut output = guard.create_new_pdf().map_err(|e| e.to_string())?;
    output
        .pages_mut()
        .append(&source)
        .map_err(|e| e.to_string())?;
    output.save_to_bytes().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Rogner (crop)
// ---------------------------------------------------------------------------

/// Rogne chaque page en retirant des marges (points) sur les 4 côtés.
pub fn crop_pages(
    bytes: &[u8],
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> Result<Vec<u8>, String> {
    let guard = pdfium_guard()?;
    let document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len();
    for index in 0..page_count {
        let mut page = document.pages().get(index).map_err(|e| e.to_string())?;
        let pw = page.width().value as f64;
        let ph = page.height().value as f64;
        let new_left = left.max(0.0);
        let new_bottom = bottom.max(0.0);
        let new_right = (pw - right).min(pw);
        let new_top = (ph - top).min(ph);
        if new_right - new_left < 10.0 || new_top - new_bottom < 10.0 {
            return Err("Les marges de rognage sont trop grandes pour cette page.".into());
        }
        let rect = PdfRect::new(
            PdfPoints::new(new_bottom as f32),
            PdfPoints::new(new_left as f32),
            PdfPoints::new(new_top as f32),
            PdfPoints::new(new_right as f32),
        );
        page.boundaries_mut()
            .set_crop(rect)
            .map_err(|e| e.to_string())?;
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Aplatir (flatten)
// ---------------------------------------------------------------------------

pub fn flatten(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let guard = pdfium_guard()?;
    let document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len();
    for index in 0..page_count {
        let mut page = document.pages().get(index).map_err(|e| e.to_string())?;
        page.flatten().map_err(|e| e.to_string())?;
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Extraire les images
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ExtractedImage {
    pub page: u32,
    pub index: usize,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

pub fn extract_images(bytes: &[u8]) -> Result<Vec<ExtractedImage>, String> {
    let guard = pdfium_guard()?;
    let document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let page_count = document.pages().len();
    for page_index in 0..page_count {
        let page = document.pages().get(page_index).map_err(|e| e.to_string())?;
        for (obj_index, object) in page.objects().iter().enumerate() {
            if object.object_type() != PdfPageObjectType::Image {
                continue;
            }
            let Some(image_object) = object.as_image_object() else {
                continue;
            };
            let Ok(image) = image_object.get_raw_image() else {
                continue;
            };
            let mut png = Vec::new();
            if image
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .is_err()
            {
                continue;
            }
            out.push(ExtractedImage {
                page: page_index as u32 + 1,
                index: obj_index,
                width: image.width(),
                height: image.height(),
                png,
            });
        }
    }
    if out.is_empty() {
        return Err("Aucune image trouvée dans ce document.".into());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Caviardage automatique par motif
// ---------------------------------------------------------------------------

/// Recherche chaque terme sur chaque page et caviarde réellement les zones
/// (texte supprimé + rectangle noir), via le moteur pdf_edit::redact.
pub fn auto_redact(
    bytes: &[u8],
    terms: &[String],
    match_case: bool,
) -> Result<(Vec<u8>, usize), String> {
    let terms: Vec<&String> = terms.iter().filter(|t| !t.trim().is_empty()).collect();
    if terms.is_empty() {
        return Err("Fournis au moins un terme à caviarder.".into());
    }

    let mut areas: Vec<(u32, (f64, f64, f64, f64))> = Vec::new();
    {
        let guard = pdfium_guard()?;
        let document = guard
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        let options = PdfSearchOptions::new().match_case(match_case);
        let page_count = document.pages().len();
        for page_index in 0..page_count {
            let page = document.pages().get(page_index).map_err(|e| e.to_string())?;
            let ph = page.height().value as f64;
            let text = page.text().map_err(|e| e.to_string())?;
            for term in &terms {
                let search = match text.search(term, &options) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                while let Some(segments) = search.find_next() {
                    for segment in segments.iter() {
                        let b = segment.bounds();
                        let left = b.left().value as f64;
                        let right = b.right().value as f64;
                        let top = ph - b.top().value as f64;
                        let bottom = ph - b.bottom().value as f64;
                        // Petite marge pour couvrir entièrement les glyphes.
                        areas.push((
                            page_index as u32 + 1,
                            (left - 1.0, top - 1.0, right + 1.0, bottom + 1.0),
                        ));
                    }
                }
            }
        }
    }

    if areas.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let count = areas.len();
    let outcome = crate::pdf_edit::redact(bytes, &areas, false)?;
    Ok((outcome.bytes, count))
}

// ---------------------------------------------------------------------------
// Sanitize (retirer JavaScript / actions automatiques)
// ---------------------------------------------------------------------------

pub fn sanitize(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use lopdf::{Document, Object};

    let mut document = Document::load_mem(bytes).map_err(|e| format!("PDF illisible : {e}"))?;

    // 1) Retirer les actions automatiques et le JavaScript du catalogue.
    let root_id = match document.trailer.get(b"Root") {
        Ok(Object::Reference(id)) => Some(*id),
        _ => None,
    };
    if let Some(root_id) = root_id {
        if let Ok(catalog) = document.get_object_mut(root_id).and_then(Object::as_dict_mut) {
            catalog.remove(b"OpenAction");
            catalog.remove(b"AA");
            if let Ok(names_ref) = catalog.get(b"Names").map(|o| o.clone()) {
                // On retirera la branche JavaScript ci-dessous via l'objet Names.
                if let Object::Reference(names_id) = names_ref {
                    if let Ok(names) =
                        document.get_object_mut(names_id).and_then(Object::as_dict_mut)
                    {
                        names.remove(b"JavaScript");
                    }
                }
            }
        }
    }

    // 2) Purger les actions JS et déclencheurs disséminés dans les objets.
    let ids: Vec<_> = document.objects.keys().cloned().collect();
    for id in ids {
        if let Ok(dict) = document.get_object_mut(id).and_then(Object::as_dict_mut) {
            let is_js_action = matches!(dict.get(b"S"), Ok(Object::Name(name)) if name == b"JavaScript");
            if is_js_action {
                dict.remove(b"JS");
            }
            dict.remove(b"AA");
        }
    }

    document.adjust_zero_pages();
    let mut out = Vec::new();
    document
        .save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("Sauvegarde impossible : {e}"))?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Marque-pages (lecture / écriture)
// ---------------------------------------------------------------------------

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct BookmarkItem {
    pub title: String,
    /// Numéro de page 1-based.
    pub page: u32,
}

pub fn get_bookmarks(bytes: &[u8]) -> Result<Vec<BookmarkItem>, String> {
    let guard = pdfium_guard()?;
    let document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    collect_bookmarks(&document, document.bookmarks().root(), &mut items);
    Ok(items)
}

fn collect_bookmarks(
    document: &PdfDocument,
    node: Option<PdfBookmark>,
    out: &mut Vec<BookmarkItem>,
) {
    let mut current = node;
    while let Some(bookmark) = current {
        let title = bookmark.title().unwrap_or_default();
        let page = bookmark
            .destination()
            .and_then(|dest| dest.page_index().ok())
            .map(|idx| idx as u32 + 1)
            .unwrap_or(0);
        if !title.is_empty() {
            out.push(BookmarkItem { title, page });
        }
        collect_bookmarks(document, bookmark.first_child(), out);
        current = bookmark.next_sibling();
    }
}

/// Remplace l'arborescence de marque-pages par une liste plate (titre + page).
pub fn set_bookmarks(bytes: &[u8], items: &[BookmarkItem]) -> Result<Vec<u8>, String> {
    use lopdf::{Bookmark, Document, Object};

    let mut document = Document::load_mem(bytes).map_err(|e| format!("PDF illisible : {e}"))?;
    let pages: Vec<(u32, lopdf::ObjectId)> = document.get_pages().into_iter().collect();
    if pages.is_empty() {
        return Err("Document sans page.".into());
    }

    // Repartir d'une arborescence vide.
    let root_id = match document.trailer.get(b"Root") {
        Ok(Object::Reference(id)) => Some(*id),
        _ => None,
    };
    if let Some(root_id) = root_id {
        if let Ok(catalog) = document.get_object_mut(root_id).and_then(Object::as_dict_mut) {
            catalog.remove(b"Outlines");
        }
    }
    document.bookmark_table.clear();

    for item in items {
        if item.title.trim().is_empty() {
            continue;
        }
        let page_number = item.page.max(1);
        let page_id = pages
            .iter()
            .find(|(n, _)| *n == page_number)
            .map(|(_, id)| *id)
            .unwrap_or(pages[0].1);
        let bookmark = Bookmark::new(item.title.clone(), [0.0, 0.0, 0.0], 0, page_id);
        document.add_bookmark(bookmark, None);
    }

    if let (Some(root_id), Some(outline_id)) = (root_id, document.build_outline()) {
        if let Ok(catalog) = document.get_object_mut(root_id).and_then(Object::as_dict_mut) {
            catalog.set("Outlines", Object::Reference(outline_id));
        }
    }

    document.adjust_zero_pages();
    let mut out = Vec::new();
    document
        .save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("Sauvegarde impossible : {e}"))?;
    Ok(out)
}
