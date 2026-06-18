use image::{imageops, DynamicImage, GrayImage, ImageBuffer, ImageFormat, Luma, Rgb, RgbImage};
use pdfium_render::prelude::*;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Serialize)]
pub struct OcrBlock {
    pub id: String,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub confidence: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageResult {
    pub blocks: Vec<OcrBlock>,
    pub image_width: u32,
    pub image_height: u32,
    pub page_width: f64,
    pub page_height: f64,
    pub deskew_angle: f64,
}

pub fn recognize_png(
    image_bytes: &[u8],
    language: Option<String>,
) -> Result<Vec<OcrBlock>, String> {
    if image_bytes.is_empty() {
        return Err("No page image was provided for OCR.".to_string());
    }

    #[cfg(target_os = "macos")]
    match recognize_with_apple_vision(image_bytes, language.clone()) {
        Ok(blocks) => return Ok(blocks),
        Err(error) => {
            tracing::warn!("Apple Vision OCR unavailable, falling back to Tesseract: {error}");
        }
    }

    recognize_with_tesseract(image_bytes, language)
}

pub fn recognize_pdf_page(
    pdf_bytes: &[u8],
    page_number: u32,
    language: Option<String>,
) -> Result<OcrPageResult, String> {
    if !pdf_bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    let guard = crate::pdf_engine::pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(pdf_bytes, None)
        .map_err(|e| e.to_string())?;
    let page_index = page_number
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
    let page = document
        .pages()
        .get(page_index)
        .map_err(|e| e.to_string())?;
    let page_width = page.width().value as f64;
    let page_height = page.height().value as f64;
    let target_width = ((page_width / 72.0) * 300.0).round().clamp(1600.0, 3600.0) as i32;

    let rendered = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(target_width)
                .render_form_data(true),
        )
        .map_err(|e| e.to_string())?
        .as_image()
        .map_err(|e| e.to_string())?;

    let (processed, deskew_angle) = preprocess_for_ocr(rendered);
    let image_width = processed.width();
    let image_height = processed.height();
    let png = encode_png(DynamicImage::ImageLuma8(processed))?;
    let blocks = recognize_png(&png, language)?;

    Ok(OcrPageResult {
        blocks,
        image_width,
        image_height,
        page_width,
        page_height,
        deskew_angle,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskewedPage {
    pub page: u32,
    pub angle: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskewResult {
    pub bytes: Vec<u8>,
    pub corrected: Vec<DeskewedPage>,
}

/// Redresse un document scanné : détecte l'angle d'inclinaison de chaque page
/// (profil de projection horizontal) et reconstruit un PDF avec les pages
/// pivotées d'autant. Les pages droites sont conservées telles quelles.
pub fn deskew_pdf(pdf_bytes: &[u8]) -> Result<DeskewResult, String> {
    if !pdf_bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    let guard = crate::pdf_engine::pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(pdf_bytes, None)
        .map_err(|e| e.to_string())?;

    let mut pages_out = Vec::new();
    let mut corrected = Vec::new();
    for (index, page) in document.pages().iter().enumerate() {
        let page_width = page.width().value as f64;
        let page_height = page.height().value as f64;
        // Comme Adobe : on travaille à la résolution native du scan, bornée
        // 200–600 DPI, avec 300 DPI par défaut quand elle est inconnue.
        let dpi = native_scan_dpi(&page).unwrap_or(300.0).clamp(200.0, 600.0);
        let target_width = ((page_width / 72.0) * dpi).round().clamp(1200.0, 5000.0) as i32;
        let rendered = page
            .render_with_config(
                &PdfRenderConfig::new()
                    .set_target_width(target_width)
                    .render_form_data(true),
            )
            .map_err(|e| e.to_string())?
            .as_image()
            .map_err(|e| e.to_string())?;

        let gray = stretch_contrast(rendered.to_luma8());
        let threshold = otsu_threshold(&gray);
        let binary = binarize(&gray, threshold);
        let angle = detect_skew_angle(&binary);

        let rgb = rendered.to_rgb8();
        let final_rgb = if angle.abs() >= 0.3 {
            corrected.push(DeskewedPage {
                page: index as u32 + 1,
                angle,
            });
            rotate_rgb_same(&rgb, angle)
        } else {
            rgb
        };

        let jpeg = encode_jpeg(&final_rgb, 88)?;
        pages_out.push(crate::pdf_engine::FlattenedPage {
            jpeg_bytes: jpeg,
            width: page_width,
            height: page_height,
        });
    }

    let bytes = crate::pdf_engine::export_flattened_pdf(pages_out)?;
    Ok(DeskewResult { bytes, corrected })
}

/// Image OCR d'une page (déjà prétraitée) + dimensions, prête à être reconnue
/// hors du verrou PDFium.
struct OcrPagePrep {
    png: Vec<u8>,
    image_width: u32,
    image_height: u32,
    page_width: f64,
    page_height: f64,
}

/// Rend une page en image OCR (300 DPI borné, contraste + binarisation +
/// redressement) et l'encode en PNG. À appeler sous le verrou PDFium.
fn render_page_for_ocr(page: &PdfPage) -> Result<OcrPagePrep, String> {
    let page_width = page.width().value as f64;
    let page_height = page.height().value as f64;
    let target_width = ((page_width / 72.0) * 300.0).round().clamp(1600.0, 3600.0) as i32;

    let rendered = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(target_width)
                .render_form_data(true),
        )
        .map_err(|e| e.to_string())?
        .as_image()
        .map_err(|e| e.to_string())?;

    let (processed, _deskew_angle) = preprocess_for_ocr(rendered);
    let image_width = processed.width();
    let image_height = processed.height();
    let png = encode_png(DynamicImage::ImageLuma8(processed))?;

    Ok(OcrPagePrep {
        png,
        image_width,
        image_height,
        page_width,
        page_height,
    })
}

/// Construit une version recherchable du PDF : OCR chaque page, puis incruste
/// le texte reconnu sous forme d'objets texte **invisibles** (render mode 3),
/// positionnés sur les blocs détectés. Le rendu visuel est inchangé ; le texte
/// devient sélectionnable, copiable et recherchable (y compris par d'autres
/// lecteurs PDF). Renvoie le PDF enrichi + le nombre de blocs ajoutés.
///
/// Pipeline : rendu série (PDFium mono-thread) → OCR parallèle → injection série.
pub fn ocr_searchable_pdf(
    pdf_bytes: &[u8],
    language: Option<String>,
) -> Result<(Vec<u8>, usize), String> {
    if !pdf_bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    // 1) Rendu série de chaque page en image OCR (PDFium est mono-thread, donc
    //    cette phase reste sous un seul verrou).
    let preps: Vec<OcrPagePrep> = {
        let guard = crate::pdf_engine::pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(pdf_bytes, None)
            .map_err(|e| e.to_string())?;
        if document.pages().is_empty() {
            return Err("This PDF has no page to process.".to_string());
        }
        let mut preps = Vec::with_capacity(document.pages().len() as usize);
        for page in document.pages().iter() {
            preps.push(render_page_for_ocr(&page)?);
        }
        preps
    };

    // 2) OCR EN PARALLÈLE : chaque page est reconnue indépendamment (Apple Vision
    //    ou Tesseract en sous-processus), sans toucher à PDFium → vrai gain.
    let results: Vec<Result<Vec<OcrBlock>, String>> = preps
        .par_iter()
        .map(|prep| recognize_png(&prep.png, language.clone()))
        .collect();
    if results.iter().all(Result::is_err) {
        return results
            .into_iter()
            .find_map(Result::err)
            .map(Err)
            .unwrap_or_else(|| Err("OCR failed.".to_string()));
    }
    let blocks_per_page: Vec<Vec<OcrBlock>> = results
        .into_iter()
        .map(Result::unwrap_or_default)
        .collect();

    // 3) Injection série du calque invisible dans un document mutable.
    let guard = crate::pdf_engine::pdfium_guard()?;
    let pdfium = &*guard;
    let mut document = pdfium
        .load_pdf_from_byte_slice(pdf_bytes, None)
        .map_err(|e| e.to_string())?;
    let font = document.fonts_mut().helvetica();

    let mut total_blocks = 0usize;
    for (index, prep) in preps.iter().enumerate() {
        if prep.image_width == 0 || prep.image_height == 0 {
            continue;
        }
        let blocks = &blocks_per_page[index];
        let scale_x = prep.page_width / prep.image_width as f64;
        let scale_y = prep.page_height / prep.image_height as f64;

        let mut page = document
            .pages()
            .get(index as i32)
            .map_err(|e| e.to_string())?;

        for block in blocks {
            let text = block.text.trim();
            if text.is_empty() {
                continue;
            }

            let left = block.x * scale_x;
            let box_bottom = prep.page_height - (block.y + block.height) * scale_y;
            let target_width = block.width * scale_x;
            let font_size = ((block.height * scale_y) * 0.8).clamp(1.0, 1000.0);

            let mut object = page
                .objects_mut()
                .create_text_object(
                    PdfPoints::new(0.0),
                    PdfPoints::new(0.0),
                    text,
                    font,
                    PdfPoints::new(font_size as f32),
                )
                .map_err(|e| e.to_string())?;

            // Mise à l'échelle horizontale pour épouser la largeur du bloc OCR :
            // la sélection/copie suit alors le texte d'origine.
            let natural_width = object
                .bounds()
                .map(|b| b.width().value as f64)
                .unwrap_or(0.0);
            let scale_h = if natural_width > 0.1 && target_width > 0.1 {
                (target_width / natural_width).clamp(0.01, 100.0)
            } else {
                1.0
            };
            object
                .transform(scale_h as f32, 0.0, 0.0, 1.0, left as f32, box_bottom as f32)
                .map_err(|e| e.to_string())?;

            if let Some(text_object) = object.as_text_object_mut() {
                text_object
                    .set_render_mode(PdfPageTextRenderMode::Invisible)
                    .map_err(|e| e.to_string())?;
            }
            total_blocks += 1;
        }

        page.regenerate_content().map_err(|e| e.to_string())?;
    }

    if total_blocks == 0 {
        return Err("No text was recognized in this document.".to_string());
    }

    let out = document.save_to_bytes().map_err(|e| e.to_string())?;
    Ok((out, total_blocks))
}

/// Résolution intrinsèque du scan : DPI de la plus grande image de la page
/// (le fond scanné). None si la page n'est pas un scan.
fn native_scan_dpi(page: &PdfPage) -> Option<f64> {
    let page_area = page.width().value as f64 * page.height().value as f64;
    let mut best: Option<f64> = None;
    for object in page.objects().iter() {
        let Some(image) = object.as_image_object() else {
            continue;
        };
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let area = bounds.width().value as f64 * bounds.height().value as f64;
        if page_area <= 0.0 || area < page_area * 0.3 {
            continue;
        }
        if let Ok(dpi) = image.horizontal_dpi() {
            let dpi = dpi as f64;
            if dpi > 1.0 {
                best = Some(best.map_or(dpi, |current: f64| current.max(dpi)));
            }
        }
    }
    best
}

fn encode_jpeg(image: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode_image(image)
        .map_err(|e| format!("Unable to encode deskewed page: {e}"))?;
    Ok(out.into_inner())
}

fn encode_png(image: DynamicImage) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| format!("Unable to encode OCR image: {e}"))?;
    Ok(out.into_inner())
}

fn preprocess_for_ocr(image: DynamicImage) -> (GrayImage, f64) {
    let gray = stretch_contrast(image.to_luma8());
    let threshold = otsu_threshold(&gray);
    let binary = binarize(&gray, threshold);
    let angle = detect_skew_angle(&binary);
    if angle.abs() < 0.35 {
        (gray, 0.0)
    } else {
        (rotate_luma_same(&gray, angle), angle)
    }
}

fn stretch_contrast(mut image: GrayImage) -> GrayImage {
    let mut hist = [0u32; 256];
    for pixel in image.pixels() {
        hist[pixel[0] as usize] += 1;
    }
    let total = image.width().saturating_mul(image.height()).max(1);
    let low_target = total / 100;
    let high_target = total - low_target;
    let mut acc = 0u32;
    let mut low = 0u8;
    for (idx, count) in hist.iter().enumerate() {
        acc += *count;
        if acc >= low_target {
            low = idx as u8;
            break;
        }
    }
    acc = 0;
    let mut high = 255u8;
    for (idx, count) in hist.iter().enumerate() {
        acc += *count;
        if acc >= high_target {
            high = idx as u8;
            break;
        }
    }
    if high <= low.saturating_add(8) {
        return image;
    }
    for pixel in image.pixels_mut() {
        let value = pixel[0];
        let stretched = if value <= low {
            0
        } else if value >= high {
            255
        } else {
            (((value - low) as f32 / (high - low) as f32) * 255.0).round() as u8
        };
        pixel[0] = stretched;
    }
    image
}

fn otsu_threshold(image: &GrayImage) -> u8 {
    let mut hist = [0u32; 256];
    for pixel in image.pixels() {
        hist[pixel[0] as usize] += 1;
    }
    let total = (image.width() * image.height()).max(1) as f64;
    let mut sum = 0.0;
    for (idx, count) in hist.iter().enumerate() {
        sum += (idx as f64) * (*count as f64);
    }
    let mut sum_b = 0.0;
    let mut w_b = 0.0;
    let mut max_between = 0.0;
    let mut threshold = 170u8;
    for (idx, count) in hist.iter().enumerate() {
        w_b += *count as f64;
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += (idx as f64) * (*count as f64);
        let m_b = sum_b / w_b;
        let m_f = (sum - sum_b) / w_f;
        let between = w_b * w_f * (m_b - m_f).powi(2);
        if between > max_between {
            max_between = between;
            threshold = idx as u8;
        }
    }
    threshold
}

fn binarize(image: &GrayImage, threshold: u8) -> GrayImage {
    ImageBuffer::from_fn(image.width(), image.height(), |x, y| {
        if image.get_pixel(x, y)[0] <= threshold {
            Luma([0u8])
        } else {
            Luma([255u8])
        }
    })
}

fn detect_skew_angle(binary: &GrayImage) -> f64 {
    let max_width = 900;
    let sample = if binary.width() > max_width {
        let ratio = max_width as f32 / binary.width() as f32;
        imageops::resize(
            binary,
            max_width,
            (binary.height() as f32 * ratio).round().max(1.0) as u32,
            imageops::FilterType::Triangle,
        )
    } else {
        binary.clone()
    };

    let mut best_angle = 0.0;
    let mut best_score = 0.0;
    for step in -30..=30 {
        let angle = step as f64 * 0.5;
        let rotated = rotate_luma_same(&sample, angle);
        let score = horizontal_projection_score(&rotated);
        if score > best_score {
            best_score = score;
            best_angle = angle;
        }
    }

    // Raffinage à 0,1° autour du meilleur angle grossier : un scan incliné de
    // 2,3° redressé de 2,5° resterait visiblement de travers.
    let coarse = best_angle;
    for step in -4..=4 {
        if step == 0 {
            continue;
        }
        let angle = coarse + step as f64 * 0.1;
        let rotated = rotate_luma_same(&sample, angle);
        let score = horizontal_projection_score(&rotated);
        if score > best_score {
            best_score = score;
            best_angle = angle;
        }
    }
    best_angle
}

/// Rotation couleur avec interpolation bilinéaire et fond blanc, mêmes
/// dimensions que l'original (le contenu d'un scan incliné ne touche pas les
/// bords, donc rien d'utile n'est rogné).
fn rotate_rgb_same(image: &RgbImage, angle_degrees: f64) -> RgbImage {
    let width = image.width();
    let height = image.height();
    let cx = (width as f64 - 1.0) / 2.0;
    let cy = (height as f64 - 1.0) / 2.0;
    let angle = angle_degrees.to_radians();
    let (sin, cos) = angle.sin_cos();

    ImageBuffer::from_fn(width, height, |x, y| {
        let dx = x as f64 - cx;
        let dy = y as f64 - cy;
        let src_x = cos * dx + sin * dy + cx;
        let src_y = -sin * dx + cos * dy + cy;
        if src_x < 0.0 || src_y < 0.0 || src_x > (width - 1) as f64 || src_y > (height - 1) as f64
        {
            return Rgb([255, 255, 255]);
        }
        let x0 = src_x.floor() as u32;
        let y0 = src_y.floor() as u32;
        let x1 = (x0 + 1).min(width - 1);
        let y1 = (y0 + 1).min(height - 1);
        let fx = src_x - x0 as f64;
        let fy = src_y - y0 as f64;
        let p00 = image.get_pixel(x0, y0);
        let p10 = image.get_pixel(x1, y0);
        let p01 = image.get_pixel(x0, y1);
        let p11 = image.get_pixel(x1, y1);
        let mut out = [0u8; 3];
        for channel in 0..3 {
            let top = p00[channel] as f64 * (1.0 - fx) + p10[channel] as f64 * fx;
            let bottom = p01[channel] as f64 * (1.0 - fx) + p11[channel] as f64 * fx;
            out[channel] = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
        }
        Rgb(out)
    })
}

fn horizontal_projection_score(image: &GrayImage) -> f64 {
    let mut rows = vec![0f64; image.height() as usize];
    for (y, row) in rows.iter_mut().enumerate() {
        let mut dark = 0u32;
        for x in 0..image.width() {
            if image.get_pixel(x, y as u32)[0] < 128 {
                dark += 1;
            }
        }
        *row = dark as f64;
    }
    let mean = rows.iter().sum::<f64>() / rows.len().max(1) as f64;
    rows.iter().map(|value| (value - mean).powi(2)).sum::<f64>()
}

fn rotate_luma_same(image: &GrayImage, angle_degrees: f64) -> GrayImage {
    let width = image.width();
    let height = image.height();
    let cx = (width as f64 - 1.0) / 2.0;
    let cy = (height as f64 - 1.0) / 2.0;
    let angle = angle_degrees.to_radians();
    let cos = angle.cos();
    let sin = angle.sin();

    ImageBuffer::from_fn(width, height, |x, y| {
        let dx = x as f64 - cx;
        let dy = y as f64 - cy;
        let src_x = cos * dx + sin * dy + cx;
        let src_y = -sin * dx + cos * dy + cy;
        // Borne stricte à width-1/height-1 : round() pouvait sinon retomber
        // pile sur width/height => panic "Image index out of bounds".
        if src_x < 0.0 || src_y < 0.0 || src_x > (width - 1) as f64 || src_y > (height - 1) as f64
        {
            return Luma([255u8]);
        }
        let px = image.get_pixel(src_x.round() as u32, src_y.round() as u32)[0];
        Luma([px])
    })
}

fn recognize_with_tesseract(
    image_bytes: &[u8],
    language: Option<String>,
) -> Result<Vec<OcrBlock>, String> {
    let language = language.unwrap_or_else(|| "eng+fra".to_string());
    let mut child = Command::new("tesseract")
        .args(["stdin", "stdout", "-l", &language, "tsv"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            "Local OCR requires Tesseract to be installed on this Mac. Install it with `brew install tesseract tesseract-lang` and retry.".to_string()
        })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Unable to open OCR input stream.".to_string())?;
    stdin
        .write_all(image_bytes)
        .map_err(|e| format!("Unable to send page image to OCR: {e}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|e| format!("OCR failed to complete: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OCR failed: {}", stderr.trim()));
    }

    let tsv = String::from_utf8_lossy(&output.stdout);
    Ok(parse_tsv(&tsv))
}

#[cfg(target_os = "macos")]
fn recognize_with_apple_vision(
    image_bytes: &[u8],
    language: Option<String>,
) -> Result<Vec<OcrBlock>, String> {
    #[derive(Deserialize)]
    struct VisionBlock {
        text: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        confidence: f64,
    }

    let prefix = unique_prefix("alto-vision-ocr");
    let image_path = prefix.with_extension("png");
    let script_path = prefix.with_extension("swift");
    fs::write(&image_path, image_bytes)
        .map_err(|e| format!("Unable to prepare Vision OCR image: {e}"))?;
    fs::write(&script_path, VISION_SWIFT)
        .map_err(|e| format!("Unable to prepare Vision OCR helper: {e}"))?;

    let language = vision_language(language.as_deref());
    let output = Command::new("/usr/bin/swift")
        .arg(&script_path)
        .arg(&image_path)
        .arg(language)
        .output()
        .map_err(|e| format!("Unable to run Apple Vision OCR helper: {e}"))?;

    let _ = fs::remove_file(&image_path);
    let _ = fs::remove_file(&script_path);

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let blocks: Vec<VisionBlock> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Unable to parse Vision OCR output: {e}"))?;

    Ok(blocks
        .into_iter()
        .enumerate()
        .map(|(index, block)| OcrBlock {
            id: format!(
                "vision-{index}-{:.0}-{:.0}-{:.0}-{:.0}",
                block.x, block.y, block.width, block.height
            ),
            text: block.text,
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
            confidence: block.confidence,
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn vision_language(language: Option<&str>) -> &'static str {
    match language.unwrap_or_default() {
        value if value.contains("fra") || value.contains("fr") => "fr-FR",
        _ => "en-US",
    }
}

fn unique_prefix(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    // Compteur monotone : garantit l'unicité même pour des appels OCR concurrents
    // (même pid + même milliseconde).
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{label}-{millis}-{}-{seq}", std::process::id()))
}

#[cfg(target_os = "macos")]
const VISION_SWIFT: &str = r#"
import Foundation
import Vision
import AppKit

struct OcrBlock: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Double
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("usage: vision.swift image language\n", stderr)
    exit(2)
}

let imageUrl = URL(fileURLWithPath: args[1])
let language = args[2]
guard let image = NSImage(contentsOf: imageUrl),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("unable to load image\n", stderr)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = [language, "en-US", "fr-FR"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

let width = Double(cgImage.width)
let height = Double(cgImage.height)
let blocks = (request.results ?? []).compactMap { observation -> OcrBlock? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return OcrBlock(
        text: candidate.string,
        x: box.minX * width,
        y: (1.0 - box.maxY) * height,
        width: box.width * width,
        height: box.height * height,
        confidence: Double(candidate.confidence * 100.0)
    )
}

let data = try JSONEncoder().encode(blocks)
FileHandle.standardOutput.write(data)
"#;

fn parse_tsv(tsv: &str) -> Vec<OcrBlock> {
    tsv.lines()
        .skip(1)
        .filter_map(|line| {
            let columns = line.split('\t').collect::<Vec<_>>();
            if columns.len() < 12 {
                return None;
            }

            let confidence = columns[10].parse::<f64>().ok()?;
            let text = columns[11].trim();
            if confidence < 35.0 || text.is_empty() {
                return None;
            }

            let x = columns[6].parse::<f64>().ok()?;
            let y = columns[7].parse::<f64>().ok()?;
            let width = columns[8].parse::<f64>().ok()?;
            let height = columns[9].parse::<f64>().ok()?;

            Some(OcrBlock {
                id: format!("ocr-{x:.0}-{y:.0}-{width:.0}-{height:.0}"),
                text: text.to_string(),
                x,
                y,
                width,
                height,
                confidence,
            })
        })
        .collect()
}
