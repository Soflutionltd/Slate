// pdf_edit — inspection et édition fine de PDF via PDFium (+ lopdf pour les
// métadonnées). Alimente les outils MCP `pdf_layout`, `pdf_edit_region`,
// `pdf_replace_image`, `pdf_insert_image`, `pdf_delete_image`, `pdf_redact`,
// `pdf_set_metadata`, `pdf_stamp` et la version étendue de `pdf_replace_text`.
//
// SYSTÈME DE COORDONNÉES (identique à PyMuPDF) : origine en HAUT à GAUCHE de la
// page, axe Y vers le BAS, unité en points PDF (72 points = 1 pouce). Toutes les
// bbox sont au format [x0, y0, x1, y1] avec (x0, y0) = coin haut-gauche et
// (x1, y1) = coin bas-droit. La conversion vers le repère natif du PDF (origine
// en bas à gauche, Y vers le haut) est faite en interne.

use pdfium_render::prelude::*;
use serde_json::{json, Value};

use crate::pdf_engine::pdfium_guard;

// ---------------------------------------------------------------------------
// Helpers communs
// ---------------------------------------------------------------------------

/// bbox haut-gauche [x0,y0,x1,y1] d'un objet de page.
fn object_bbox_top_left(
    object: &PdfPageObject,
    page_height: f64,
) -> Option<(f64, f64, f64, f64)> {
    let bounds = object.bounds().ok()?;
    let left = bounds.left().value as f64;
    let top_from_bottom = bounds.top().value as f64;
    let width = bounds.width().value as f64;
    let height = bounds.height().value as f64;
    let y0 = page_height - top_from_bottom;
    Some((left, y0, left + width, y0 + height))
}

fn rects_intersect(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    a.0 < b.2 && a.2 > b.0 && a.1 < b.3 && a.3 > b.1
}

pub fn parse_bbox(value: &Value) -> Result<(f64, f64, f64, f64), String> {
    let raw = value
        .as_array()
        .filter(|a| a.len() == 4)
        .ok_or("bbox must be [x0, y0, x1, y1] (top-left origin, points)")?;
    let mut parts = [0.0f64; 4];
    for (i, item) in raw.iter().enumerate() {
        parts[i] = item
            .as_f64()
            .ok_or("bbox values must be numbers (points)")?;
    }
    if parts[2] <= parts[0] || parts[3] <= parts[1] {
        return Err("bbox must satisfy x1 > x0 and y1 > y0".to_string());
    }
    Ok((parts[0], parts[1], parts[2], parts[3]))
}

/// Identifiants stables émis par `pdf_layout` : "p{page}-t{index}" pour le
/// texte, "p{page}-i{index}" pour les images. L'index est la position de
/// l'objet sur la page, stable tant que le fichier n'est pas modifié.
fn parse_object_id(id: &str, expected_kind: char) -> Result<(u32, usize), String> {
    let rest = id
        .strip_prefix('p')
        .ok_or_else(|| format!("Invalid id '{id}': expected p<page>-{expected_kind}<index>"))?;
    let (page_str, obj) = rest
        .split_once('-')
        .ok_or_else(|| format!("Invalid id '{id}': expected p<page>-{expected_kind}<index>"))?;
    let index_str = obj
        .strip_prefix(expected_kind)
        .ok_or_else(|| format!("Invalid id '{id}': expected kind '{expected_kind}'"))?;
    let page: u32 = page_str
        .parse()
        .map_err(|_| format!("Invalid page in id '{id}'"))?;
    let index: usize = index_str
        .parse()
        .map_err(|_| format!("Invalid object index in id '{id}'"))?;
    if page == 0 {
        return Err("Page numbers are 1-based.".to_string());
    }
    Ok((page, index))
}

/// Retire l'objet `index` de la page SANS le détruire. Avec le libpdfium
/// embarqué, FPDFPageObj_Destroy après FPDFPage_RemoveObject provoque un
/// double-free (segfault) : on neutralise donc le drop de l'objet retiré.
/// La fuite est minuscule (un objet) et bornée par opération.
fn remove_page_object(
    page: &mut PdfPage,
    index: usize,
) -> Result<(), String> {
    let removed = page
        .objects_mut()
        .remove_object_at_index(index)
        .map_err(|e| format!("Unable to remove object {index}: {e}"))?;
    std::mem::forget(removed);
    Ok(())
}

fn check_page(page: u32, page_count: u32) -> Result<(), String> {
    if page == 0 || page > page_count {
        return Err(format!(
            "Page {page} out of range (document has {page_count} pages, 1-based)."
        ));
    }
    Ok(())
}

fn load_image_file(path: &str) -> Result<image::DynamicImage, String> {
    let absolute = std::path::Path::new(path);
    if !absolute.is_absolute() {
        return Err(format!("Image path must be absolute: {path}"));
    }
    if !absolute.exists() {
        return Err(format!("Image file not found: {path}"));
    }
    image::open(absolute).map_err(|e| format!("Unable to decode image {path}: {e} (PNG and JPEG are supported)"))
}

fn font_token_for(
    document: &mut PdfDocument,
    name: Option<&str>,
) -> Result<PdfFontToken, String> {
    let fonts = document.fonts_mut();
    let token = match name.unwrap_or("helvetica").to_ascii_lowercase().as_str() {
        "helvetica" | "helv" | "arial" => fonts.helvetica(),
        "helvetica-bold" | "helv-bold" => fonts.helvetica_bold(),
        "helvetica-oblique" | "helvetica-italic" => fonts.helvetica_oblique(),
        "times" | "times-roman" => fonts.times_roman(),
        "times-bold" => fonts.times_bold(),
        "times-italic" => fonts.times_italic(),
        "courier" | "mono" => fonts.courier(),
        "courier-bold" => fonts.courier_bold(),
        other => {
            return Err(format!(
                "Unsupported font '{other}'. Use one of: helvetica, helvetica-bold, helvetica-oblique, times, times-bold, times-italic, courier, courier-bold."
            ))
        }
    };
    Ok(token)
}

pub fn parse_color(value: Option<&Value>) -> Result<PdfColor, String> {
    let Some(value) = value else {
        return Ok(PdfColor::new(0, 0, 0, 255));
    };
    let raw = value
        .as_array()
        .filter(|a| a.len() == 3)
        .ok_or("color must be [r, g, b] with values 0-255")?;
    let mut parts = [0u8; 3];
    for (i, item) in raw.iter().enumerate() {
        parts[i] = item
            .as_u64()
            .filter(|v| *v <= 255)
            .ok_or("color values must be integers 0-255")? as u8;
    }
    Ok(PdfColor::new(parts[0], parts[1], parts[2], 255))
}

/// Mesure la largeur d'un texte pour une police/taille données, via un objet
/// texte temporaire (jamais ajouté à une page).
fn measure_text_width(
    document: &PdfDocument,
    text: &str,
    font: PdfFontToken,
    size: f64,
) -> Result<f64, String> {
    if text.trim().is_empty() {
        return Ok(0.0);
    }
    let object = PdfPageTextObject::new(document, text, font, PdfPoints::new(size as f32))
        .map_err(|e| e.to_string())?;
    let bounds = object.bounds().map_err(|e| e.to_string())?;
    Ok(bounds.width().value as f64)
}

/// Découpe `text` en lignes tenant dans `max_width` à la taille donnée.
/// Conserve les sauts de ligne explicites.
fn wrap_text_lines(
    document: &PdfDocument,
    text: &str,
    font: PdfFontToken,
    size: f64,
    max_width: f64,
) -> Result<Option<Vec<String>>, String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current = String::new();
        for word in words {
            if measure_text_width(document, word, font, size)? > max_width {
                // Un mot seul ne tient pas : cette taille est trop grande.
                return Ok(None);
            }
            let candidate = if current.is_empty() {
                word.to_string()
            } else {
                format!("{current} {word}")
            };
            if measure_text_width(document, &candidate, font, size)? <= max_width {
                current = candidate;
            } else {
                lines.push(current);
                current = word.to_string();
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
    }
    Ok(Some(lines))
}

/// Pose `text` dans la bbox (repère haut-gauche), avec retour à la ligne et
/// réduction automatique de la taille jusqu'à ce que tout tienne.
/// Retourne la taille effectivement utilisée.
fn insert_textbox(
    document: &mut PdfDocument,
    page_index: u32,
    bbox: (f64, f64, f64, f64),
    text: &str,
    font_name: Option<&str>,
    requested_size: f64,
    color: PdfColor,
    align: &str,
) -> Result<f64, String> {
    let font = font_token_for(document, font_name)?;
    let page_height = {
        let page = document
            .pages()
            .get(page_index as i32)
            .map_err(|e| e.to_string())?;
        page.height().value as f64
    };
    let box_width = bbox.2 - bbox.0;
    let box_height = bbox.3 - bbox.1;
    const LINE_FACTOR: f64 = 1.25;
    const MIN_SIZE: f64 = 3.5;

    // Réduction progressive jusqu'à ce que le texte tienne en largeur ET hauteur.
    // La hauteur requise compte (n-1) interlignes + la hauteur de capitales de
    // la dernière ligne (≈ 0.75 × taille), avec 10% de tolérance : les bbox de
    // runs PDF sont serrées sur les glyphes, plus basses que la taille de police.
    let mut size = requested_size.max(MIN_SIZE);
    let lines = loop {
        if let Some(lines) = wrap_text_lines(document, text, font, size, box_width)? {
            let needed_height =
                (lines.len().saturating_sub(1)) as f64 * size * LINE_FACTOR + size * 0.75;
            if needed_height <= box_height * 1.1 || size <= MIN_SIZE {
                break lines;
            }
        }
        if size <= MIN_SIZE {
            // Dernier recours : on force le découpage à la taille minimale.
            break wrap_text_lines(document, text, font, MIN_SIZE, box_width)?
                .unwrap_or_else(|| vec![text.to_string()]);
        }
        size = (size * 0.92).max(MIN_SIZE);
    };

    // Largeurs mesurées AVANT d'emprunter la page (le document est requis).
    let mut measured: Vec<(String, f64)> = Vec::with_capacity(lines.len());
    for line in &lines {
        let width = if line.trim().is_empty() {
            0.0
        } else {
            measure_text_width(document, line, font, size)?
        };
        measured.push((line.clone(), width));
    }

    let mut page = document
        .pages()
        .get(page_index as i32)
        .map_err(|e| e.to_string())?;

    for (line_index, (line, line_width)) in measured.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let x = match align {
            "center" => bbox.0 + ((box_width - line_width) / 2.0).max(0.0),
            "right" => bbox.0 + (box_width - line_width).max(0.0),
            // "justify" est traité comme "left" (espacement inter-mots non géré).
            _ => bbox.0,
        };
        // Baseline de la ligne N (repère haut-gauche -> repère PDF bas-gauche) :
        // ascente ≈ 0.75 × taille sous le haut de la ligne.
        let baseline_top = bbox.1 + line_index as f64 * size * LINE_FACTOR + size * 0.75;
        let y_pdf = page_height - baseline_top;
        let object = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(x as f32),
                PdfPoints::new(y_pdf as f32),
                line,
                font,
                PdfPoints::new(size as f32),
            )
            .map_err(|e| e.to_string())?;
        let mut object = object;
        object.set_fill_color(color).map_err(|e| e.to_string())?;
    }
    page.regenerate_content().map_err(|e| e.to_string())?;
    Ok(size)
}

// ---------------------------------------------------------------------------
// 1) pdf_layout
// ---------------------------------------------------------------------------

/// Structure exacte du document : blocs texte (runs) et images, avec des
/// identifiants stables réutilisables par les outils d'édition.
pub fn layout(bytes: &[u8], pages_filter: Option<Vec<u32>>) -> Result<Value, String> {
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;

    let selected: Vec<u32> = match pages_filter {
        Some(pages) => {
            for &p in &pages {
                check_page(p, page_count)?;
            }
            pages
        }
        None => (1..=page_count).collect(),
    };

    let mut pages_json = Vec::new();
    for page_number in selected {
        let page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        let page_height = page.height().value as f64;
        let page_width = page.width().value as f64;

        let mut text_blocks = Vec::new();
        let mut images = Vec::new();
        for (index, object) in page.objects().iter().enumerate() {
            let Some(bbox) = object_bbox_top_left(&object, page_height) else {
                continue;
            };
            let bbox_json = json!([bbox.0, bbox.1, bbox.2, bbox.3]);
            match object.object_type() {
                PdfPageObjectType::Text => {
                    let Some(text_object) = object.as_text_object() else {
                        continue;
                    };
                    let color = object
                        .fill_color()
                        .map(|c| json!([c.red(), c.green(), c.blue()]))
                        .unwrap_or(Value::Null);
                    text_blocks.push(json!({
                        "block_id": format!("p{page_number}-t{index}"),
                        "page": page_number,
                        "bbox": bbox_json,
                        "text": text_object.text(),
                        "font": text_object.font().family(),
                        "size": text_object.scaled_font_size().value,
                        "color": color
                    }));
                }
                PdfPageObjectType::Image => {
                    let Some(image_object) = object.as_image_object() else {
                        continue;
                    };
                    let width = image_object.width().unwrap_or(0);
                    let height = image_object.height().unwrap_or(0);
                    let colorspace = image_object
                        .color_space()
                        .map(|cs| format!("{cs:?}"))
                        .unwrap_or_else(|_| "Unknown".to_string());
                    images.push(json!({
                        "image_id": format!("p{page_number}-i{index}"),
                        "page": page_number,
                        "bbox": bbox_json,
                        "width": width,
                        "height": height,
                        "colorspace": colorspace
                    }));
                }
                _ => {}
            }
        }

        pages_json.push(json!({
            "page": page_number,
            "width": page_width,
            "height": page_height,
            "text_blocks": text_blocks,
            "images": images
        }));
    }

    Ok(json!({
        "page_count": page_count,
        "coordinates": "origin top-left, y down, points (72/inch); bbox = [x0, y0, x1, y1]",
        "pages": pages_json
    }))
}

// ---------------------------------------------------------------------------
// 2) pdf_replace_text étendu (regex + préservation de la bbox)
// ---------------------------------------------------------------------------

pub struct ReplaceOutcome {
    pub bytes: Vec<u8>,
    pub count: usize,
    pub shrunk_blocks: usize,
}

/// Remplace `find` par `replace` dans les runs de texte. `use_regex` active le
/// mode expression régulière (syntaxe Rust `regex`). La police d'origine est
/// conservée ; si le nouveau texte déborde de la bbox d'origine, l'objet est
/// réduit homothétiquement pour y tenir.
pub fn replace_text(
    bytes: &[u8],
    find: &str,
    replace: &str,
    page_filter: Option<u32>,
    use_regex: bool,
) -> Result<ReplaceOutcome, String> {
    let matcher = if use_regex {
        Some(regex::Regex::new(find).map_err(|e| format!("Invalid regex '{find}': {e}"))?)
    } else {
        None
    };

    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;
    if let Some(p) = page_filter {
        check_page(p, page_count)?;
    }

    let mut replaced = 0usize;
    let mut shrunk = 0usize;
    for index in 0..page_count {
        if let Some(p) = page_filter {
            if p != index + 1 {
                continue;
            }
        }
        let mut page = document
            .pages()
            .get(index as i32)
            .map_err(|e| e.to_string())?;
        let mut changed = false;
        for mut object in page.objects().iter() {
            let original_bounds = object.bounds().ok();
            let Some(text_object) = object.as_text_object_mut() else {
                continue;
            };
            let current = text_object.text();
            let (updated, occurrences) = match &matcher {
                Some(re) => {
                    let occurrences = re.find_iter(&current).count();
                    if occurrences == 0 {
                        continue;
                    }
                    (re.replace_all(&current, replace).to_string(), occurrences)
                }
                None => {
                    if !current.contains(find) {
                        continue;
                    }
                    (current.replace(find, replace), current.matches(find).count())
                }
            };
            if updated == current {
                continue;
            }
            if updated.trim().is_empty() {
                // PDFium ne supporte pas les runs vides : on pose une espace.
                text_object.set_text(" ").map_err(|e| e.to_string())?;
            } else {
                text_object.set_text(&updated).map_err(|e| e.to_string())?;
            }
            replaced += occurrences;
            changed = true;

            // Préservation de la bbox : si le nouveau texte est plus large que
            // l'ancien, réduction homothétique ancrée sur le coin bas-gauche.
            if let (Some(old), Ok(new)) = (original_bounds, object.bounds()) {
                let old_width = old.width().value as f64;
                let new_width = new.width().value as f64;
                if new_width > old_width + 0.1 && new_width > 0.0 {
                    let scale = (old_width / new_width).max(0.05);
                    let anchor_x = old.left().value as f64;
                    let anchor_y = old.bottom().value as f64;
                    object
                        .scale(scale as f32, scale as f32)
                        .map_err(|e| e.to_string())?;
                    object
                        .translate(
                            PdfPoints::new((anchor_x * (1.0 - scale)) as f32),
                            PdfPoints::new((anchor_y * (1.0 - scale)) as f32),
                        )
                        .map_err(|e| e.to_string())?;
                    shrunk += 1;
                }
            }
        }
        if changed {
            page.regenerate_content().map_err(|e| e.to_string())?;
        }
    }

    if replaced == 0 {
        return Ok(ReplaceOutcome {
            bytes: Vec::new(),
            count: 0,
            shrunk_blocks: 0,
        });
    }
    let out = document.save_to_bytes().map_err(|e| e.to_string())?;
    Ok(ReplaceOutcome {
        bytes: out,
        count: replaced,
        shrunk_blocks: shrunk,
    })
}

// ---------------------------------------------------------------------------
// 3) pdf_edit_region
// ---------------------------------------------------------------------------

pub struct EditRegionOutcome {
    pub bytes: Vec<u8>,
    pub removed_blocks: usize,
    pub final_size: f64,
    pub warnings: Vec<String>,
}

/// Caviarde une zone (suppression réelle des runs de texte qui l'intersectent)
/// puis pose `new_text` dans la même bbox avec auto-ajustement de la taille.
#[allow(clippy::too_many_arguments)]
pub fn edit_region(
    bytes: &[u8],
    page_number: u32,
    bbox: (f64, f64, f64, f64),
    new_text: &str,
    font: Option<&str>,
    size: Option<f64>,
    color: PdfColor,
    align: &str,
) -> Result<EditRegionOutcome, String> {
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let mut document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;
    check_page(page_number, page_count)?;

    let mut requested_size = size.unwrap_or(0.0);
    let removed;
    {
        let mut page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        let page_height = page.height().value as f64;

        // Indices des runs de texte à supprimer (en intersection avec la zone).
        let mut to_remove: Vec<usize> = Vec::new();
        for (index, object) in page.objects().iter().enumerate() {
            if object.object_type() != PdfPageObjectType::Text {
                continue;
            }
            let Some(object_bbox) = object_bbox_top_left(&object, page_height) else {
                continue;
            };
            if rects_intersect(object_bbox, bbox) {
                if requested_size <= 0.0 {
                    if let Some(text_object) = object.as_text_object() {
                        requested_size = text_object.scaled_font_size().value as f64;
                    }
                }
                to_remove.push(index);
            }
        }
        removed = to_remove.len();
        for index in to_remove.into_iter().rev() {
            remove_page_object(&mut page, index)?;
        }
        if removed > 0 {
            page.regenerate_content().map_err(|e| e.to_string())?;
        }
    }

    if requested_size <= 0.0 {
        requested_size = 11.0;
    }

    let mut warnings = Vec::new();
    let mut final_size = requested_size;
    if !new_text.trim().is_empty() {
        final_size = insert_textbox(
            &mut document,
            page_number - 1,
            bbox,
            new_text,
            font,
            requested_size,
            color,
            align,
        )?;
        if final_size < requested_size * 0.7 {
            warnings.push(format!(
                "Text was shrunk by more than 30% to fit the bbox ({}pt -> {:.1}pt). Consider a larger bbox or shorter text.",
                requested_size, final_size
            ));
        }
    }

    let out = document.save_to_bytes().map_err(|e| e.to_string())?;
    Ok(EditRegionOutcome {
        bytes: out,
        removed_blocks: removed,
        final_size,
        warnings,
    })
}

/// Résout la bbox d'un block_id "p{page}-t{index}" émis par `pdf_layout`.
pub fn resolve_block_bbox(bytes: &[u8], block_id: &str) -> Result<(u32, (f64, f64, f64, f64)), String> {
    let (page_number, object_index) = parse_object_id(block_id, 't')?;
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    check_page(page_number, document.pages().len() as u32)?;
    let page = document
        .pages()
        .get((page_number - 1) as i32)
        .map_err(|e| e.to_string())?;
    let page_height = page.height().value as f64;
    let object = page
        .objects()
        .get(object_index)
        .map_err(|_| format!("No object at index {object_index} on page {page_number}. Re-run pdf_layout: the file may have changed."))?;
    if object.object_type() != PdfPageObjectType::Text {
        return Err(format!(
            "Object {block_id} is not a text block. Re-run pdf_layout to get fresh ids."
        ));
    }
    let bbox = object_bbox_top_left(&object, page_height)
        .ok_or("Unable to read the block bounds")?;
    Ok((page_number, bbox))
}

// ---------------------------------------------------------------------------
// 4-6) Images : remplacer, insérer, supprimer
// ---------------------------------------------------------------------------

/// Remplace les pixels d'une image existante (position/rotation conservées,
/// la matrice de l'objet n'est pas modifiée).
pub fn replace_image(bytes: &[u8], image_id: &str, new_image_path: &str) -> Result<Vec<u8>, String> {
    let (page_number, object_index) = parse_object_id(image_id, 'i')?;
    let new_image = load_image_file(new_image_path)?;

    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    check_page(page_number, document.pages().len() as u32)?;
    let mut page = document
        .pages()
        .get((page_number - 1) as i32)
        .map_err(|e| e.to_string())?;
    let mut object = page
        .objects()
        .get(object_index)
        .map_err(|_| format!("No object at index {object_index} on page {page_number}. Re-run pdf_layout."))?;
    let Some(image_object) = object.as_image_object_mut() else {
        return Err(format!(
            "Object {image_id} is not an image. Re-run pdf_layout to get fresh ids."
        ));
    };
    image_object
        .set_image(&new_image)
        .map_err(|e| format!("Unable to replace image: {e}"))?;
    page.regenerate_content().map_err(|e| e.to_string())?;
    document.save_to_bytes().map_err(|e| e.to_string())
}

/// Insère une image dans un rectangle donné (repère haut-gauche).
pub fn insert_image(
    bytes: &[u8],
    page_number: u32,
    rect: (f64, f64, f64, f64),
    image_path: &str,
    keep_aspect: bool,
    overlay: bool,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let image = load_image_file(image_path)?;
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    check_page(page_number, document.pages().len() as u32)?;
    let mut page = document
        .pages()
        .get((page_number - 1) as i32)
        .map_err(|e| e.to_string())?;
    let page_height = page.height().value as f64;

    let rect_width = rect.2 - rect.0;
    let rect_height = rect.3 - rect.1;
    let (width, height) = if keep_aspect {
        let aspect = image.height() as f64 / image.width() as f64;
        let fitted_height = rect_width * aspect;
        if fitted_height <= rect_height {
            (rect_width, fitted_height)
        } else {
            (rect_height / aspect, rect_height)
        }
    } else {
        (rect_width, rect_height)
    };

    // Coin bas-gauche en repère PDF natif.
    let x = rect.0;
    let y_pdf = page_height - rect.1 - height;
    page.objects_mut()
        .create_image_object(
            PdfPoints::new(x as f32),
            PdfPoints::new(y_pdf as f32),
            &image,
            Some(PdfPoints::new(width as f32)),
            Some(PdfPoints::new(height as f32)),
        )
        .map_err(|e| format!("Unable to insert image: {e}"))?;
    page.regenerate_content().map_err(|e| e.to_string())?;

    let mut warnings = Vec::new();
    if !overlay {
        warnings.push(
            "overlay=false is not supported by the PDFium engine: the image was placed in the foreground."
                .to_string(),
        );
    }
    let out = document.save_to_bytes().map_err(|e| e.to_string())?;
    Ok((out, warnings))
}

/// Supprime une image. La sauvegarde passe par la compression lopdf pour
/// purger réellement l'objet du fichier.
pub fn delete_image(bytes: &[u8], image_id: &str) -> Result<Vec<u8>, String> {
    let (page_number, object_index) = parse_object_id(image_id, 'i')?;
    let intermediate;
    {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        check_page(page_number, document.pages().len() as u32)?;
        let mut page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        {
            let object = page
                .objects()
                .get(object_index)
                .map_err(|_| format!("No object at index {object_index} on page {page_number}. Re-run pdf_layout."))?;
            if object.object_type() != PdfPageObjectType::Image {
                return Err(format!(
                    "Object {image_id} is not an image. Re-run pdf_layout to get fresh ids."
                ));
            }
        }
        remove_page_object(&mut page, object_index)?;
        page.regenerate_content().map_err(|e| e.to_string())?;
        intermediate = document.save_to_bytes().map_err(|e| e.to_string())?;
    }
    // Purge des objets orphelins (équivalent garbage collection + deflate).
    crate::pdf_ops::compress_pdf(intermediate.clone()).or(Ok(intermediate))
}

// ---------------------------------------------------------------------------
// 7) pdf_redact
// ---------------------------------------------------------------------------

pub struct RedactOutcome {
    pub bytes: Vec<u8>,
    pub removed_text_blocks: usize,
    pub removed_images: usize,
}

/// Caviardage réel : les runs de texte (et optionnellement les images) qui
/// intersectent les zones sont SUPPRIMÉS du contenu (non récupérables), puis
/// un rectangle noir est posé sur chaque zone.
pub fn redact(
    bytes: &[u8],
    areas: &[(u32, (f64, f64, f64, f64))],
    remove_images: bool,
) -> Result<RedactOutcome, String> {
    if areas.is_empty() {
        return Err("Provide at least one area: { page, bbox }.".to_string());
    }
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;
    for (page_number, _) in areas {
        check_page(*page_number, page_count)?;
    }

    let mut removed_text = 0usize;
    let mut removed_images = 0usize;
    for page_number in 1..=page_count {
        let page_areas: Vec<(f64, f64, f64, f64)> = areas
            .iter()
            .filter(|(p, _)| *p == page_number)
            .map(|(_, b)| *b)
            .collect();
        if page_areas.is_empty() {
            continue;
        }
        let mut page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        let page_height = page.height().value as f64;

        let mut to_remove: Vec<usize> = Vec::new();
        for (index, object) in page.objects().iter().enumerate() {
            let kind = object.object_type();
            let is_text = kind == PdfPageObjectType::Text;
            let is_image = kind == PdfPageObjectType::Image;
            if !is_text && !(remove_images && is_image) {
                continue;
            }
            let Some(object_bbox) = object_bbox_top_left(&object, page_height) else {
                continue;
            };
            if page_areas.iter().any(|area| rects_intersect(object_bbox, *area)) {
                to_remove.push(index);
                if is_text {
                    removed_text += 1;
                } else {
                    removed_images += 1;
                }
            }
        }
        for index in to_remove.into_iter().rev() {
            remove_page_object(&mut page, index)?;
        }

        // Rectangle noir par zone (preuve visuelle du caviardage).
        for area in &page_areas {
            let rect = PdfRect::new(
                PdfPoints::new((page_height - area.3) as f32),
                PdfPoints::new(area.0 as f32),
                PdfPoints::new((page_height - area.1) as f32),
                PdfPoints::new(area.2 as f32),
            );
            page.objects_mut()
                .create_path_object_rect(rect, None, None, Some(PdfColor::new(0, 0, 0, 255)))
                .map_err(|e| format!("Unable to draw redaction rectangle: {e}"))?;
        }
        page.regenerate_content().map_err(|e| e.to_string())?;
    }

    let out = document.save_to_bytes().map_err(|e| e.to_string())?;
    Ok(RedactOutcome {
        bytes: out,
        removed_text_blocks: removed_text,
        removed_images,
    })
}

// ---------------------------------------------------------------------------
// 8) pdf_set_metadata (lopdf)
// ---------------------------------------------------------------------------

/// Met à jour les métadonnées du document. Seuls les champs fournis sont
/// modifiés ; les autres sont conservés tels quels.
pub fn set_metadata(
    bytes: &[u8],
    title: Option<&str>,
    author: Option<&str>,
    subject: Option<&str>,
    keywords: Option<&str>,
) -> Result<Vec<u8>, String> {
    use lopdf::{Dictionary, Document, Object};

    if title.is_none() && author.is_none() && subject.is_none() && keywords.is_none() {
        return Err("Provide at least one of: title, author, subject, keywords.".to_string());
    }

    let mut document =
        Document::load_mem(bytes).map_err(|e| format!("Unable to parse PDF: {e}"))?;

    let info_id = match document.trailer.get(b"Info") {
        Ok(Object::Reference(id)) => *id,
        _ => {
            let id = document.add_object(Object::Dictionary(Dictionary::new()));
            document.trailer.set("Info", Object::Reference(id));
            id
        }
    };
    let info = document
        .get_object_mut(info_id)
        .and_then(Object::as_dict_mut)
        .map_err(|e| format!("Unable to access the Info dictionary: {e}"))?;

    let mut set_field = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            info.set(key, Object::string_literal(value));
        }
    };
    set_field("Title", title);
    set_field("Author", author);
    set_field("Subject", subject);
    set_field("Keywords", keywords);

    let mut out = Vec::new();
    document
        .save_to(&mut out)
        .map_err(|e| format!("Unable to save PDF: {e}"))?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// 9) pdf_stamp
// ---------------------------------------------------------------------------

/// Appose un texte OU une image à une position (repère haut-gauche, points).
/// Pour un texte, (x, y) est le coin haut-gauche de la ligne. Pour une image,
/// (x, y) est le coin haut-gauche ; la taille naturelle est utilisée
/// (1 pixel = 0.75 point), sauf si `width` est fourni.
#[allow(clippy::too_many_arguments)]
pub fn stamp(
    bytes: &[u8],
    page_number: u32,
    x: f64,
    y: f64,
    text: Option<&str>,
    font: Option<&str>,
    size: f64,
    color: PdfColor,
    image_path: Option<&str>,
    image_width: Option<f64>,
) -> Result<Vec<u8>, String> {
    if text.is_none() && image_path.is_none() {
        return Err("Provide either 'text' or 'image_path'.".to_string());
    }
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let mut document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    check_page(page_number, document.pages().len() as u32)?;

    if let Some(text) = text {
        let font_token = font_token_for(&mut document, font)?;
        let mut page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        let page_height = page.height().value as f64;
        // (x, y) haut-gauche -> baseline PDF (origine bas-gauche).
        let y_pdf = page_height - y - size;
        let object = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(x as f32),
                PdfPoints::new(y_pdf as f32),
                text,
                font_token,
                PdfPoints::new(size as f32),
            )
            .map_err(|e| e.to_string())?;
        let mut object = object;
        object.set_fill_color(color).map_err(|e| e.to_string())?;
        page.regenerate_content().map_err(|e| e.to_string())?;
    } else if let Some(image_path) = image_path {
        let image = load_image_file(image_path)?;
        let mut page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        let page_height = page.height().value as f64;
        let natural_width = image.width() as f64 * 0.75;
        let width = image_width.unwrap_or(natural_width);
        let aspect = image.height() as f64 / image.width() as f64;
        let height = width * aspect;
        let y_pdf = page_height - y - height;
        page.objects_mut()
            .create_image_object(
                PdfPoints::new(x as f32),
                PdfPoints::new(y_pdf as f32),
                &image,
                Some(PdfPoints::new(width as f32)),
                Some(PdfPoints::new(height as f32)),
            )
            .map_err(|e| format!("Unable to stamp image: {e}"))?;
        page.regenerate_content().map_err(|e| e.to_string())?;
    }

    document.save_to_bytes().map_err(|e| e.to_string())
}
