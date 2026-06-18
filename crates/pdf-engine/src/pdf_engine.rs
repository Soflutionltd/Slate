use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

// PDFium ne peut être lié qu'UNE seule fois par process (BINDINGS global dans
// pdfium-render). On garde donc une instance unique partagée, protégée par un
// Mutex (PDFium n'est pas thread-safe).
static PDFIUM: OnceLock<Option<Mutex<Pdfium>>> = OnceLock::new();

fn create_pdfium() -> Option<Pdfium> {
    for dir in pdfium_search_dirs() {
        let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
        if lib.exists() {
            if let Ok(bindings) = Pdfium::bind_to_library(&lib) {
                return Some(Pdfium::new(bindings));
            }
        }
    }
    Pdfium::bind_to_system_library().map(Pdfium::new).ok()
}

/// Verrouille l'instance PDFium partagée (liée une seule fois, à la demande).
pub fn pdfium_guard() -> Result<MutexGuard<'static, Pdfium>, String> {
    let cell = PDFIUM.get_or_init(|| create_pdfium().map(Mutex::new));
    let mtx = cell
        .as_ref()
        .ok_or_else(|| "PDFium library unavailable".to_string())?;
    mtx.lock().map_err(|e| e.to_string())
}

fn pdfium_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("../Resources"));
            dirs.push(dir.join("../Frameworks"));
        }
    }
    // Chemin explicite (tests, déploiements sur mesure).
    if let Ok(custom) = std::env::var("ALTO_PDFIUM_DIR") {
        if !custom.is_empty() {
            dirs.push(PathBuf::from(custom));
        }
    }
    // Racine du crate : la dylib y est présente en dev/CI (libpdfium.dylib).
    // En production ce chemin n'existe pas sur la machine de l'utilisateur, il est
    // donc simplement ignoré (les dossiers près de l'exécutable priment).
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    dirs
}

#[derive(Debug, Serialize)]
pub struct PdfAnalysis {
    pub page: u32,
    #[serde(rename = "pageWidth")]
    pub page_width: f64,
    #[serde(rename = "pageHeight")]
    pub page_height: f64,
    pub blocks: Vec<PdfEditBlock>,
    pub engine: String,
}

#[derive(Debug, Serialize)]
pub struct PdfEditBlock {
    pub id: String,
    pub kind: String,
    pub page: u32,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(rename = "fontSize")]
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub serif: bool,
    #[serde(rename = "fontName")]
    pub font_name: String,
    pub justified: bool,
    pub chars: Vec<PdfCharBox>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfCharBox {
    pub text: String,
    // Boîte LARGE (loose bounds) : hauteur de ligne uniforme, inclut l'avance des
    // espaces => fiable pour le hit-test du caret et le regroupement en lignes.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    // Boîte SERRÉE (tight bounds) : épouse le glyphe => utilisée pour masquer un
    // caractère supprimé sans mordre sur ses voisins.
    #[serde(rename = "maskX")]
    pub mask_x: f64,
    #[serde(rename = "maskY")]
    pub mask_y: f64,
    #[serde(rename = "maskWidth")]
    pub mask_width: f64,
    #[serde(rename = "maskHeight")]
    pub mask_height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlattenedPage {
    pub jpeg_bytes: Vec<u8>,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
struct TextSegment {
    text: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    font_size: f64,
    bold: bool,
    italic: bool,
    serif: bool,
    font_name: String,
    justified: bool,
    chars: Vec<PdfCharBox>,
}

fn should_insert_visual_space(previous: &TextSegment, current: &TextSegment) -> bool {
    let gap = current.x - (previous.x + previous.width);
    if gap <= 0.0 {
        return false;
    }

    let ref_size = previous
        .font_size
        .max(current.font_size)
        .max(previous.height.max(current.height))
        .max(1.0);
    if gap <= (ref_size * 0.22).max(1.5) {
        return false;
    }

    let prev_last = previous.text.chars().rev().find(|c| !c.is_whitespace());
    let current_first = current.text.chars().find(|c| !c.is_whitespace());
    match (prev_last, current_first) {
        (_, Some(c)) if ".,;:!?)]}%".contains(c) => false,
        (Some(c), _) if "([{".contains(c) => false,
        _ => true,
    }
}

fn merge_segment_texts(group: &[TextSegment]) -> String {
    let mut merged = String::new();
    let mut previous: Option<&TextSegment> = None;

    for segment in group {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        if let Some(prev) = previous {
            if should_insert_visual_space(prev, segment) && !merged.ends_with(' ') {
                merged.push(' ');
            }
        }
        merged.push_str(text);
        previous = Some(segment);
    }

    merged
}

fn merge_segment_chars(group: &[TextSegment]) -> Vec<PdfCharBox> {
    let mut chars = group
        .iter()
        .flat_map(|segment| segment.chars.iter().cloned())
        .collect::<Vec<_>>();
    chars.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    chars
}

/// Découpe un segment PDFium contenant un grand blanc interne (tabulation,
/// cellules de tableau émises dans un seul run : « DATE␣␣␣␣REFERENCE »).
/// Sans ce découpage, les deux cellules forment un seul bloc éditable.
fn split_segment_on_column_gaps(segment: TextSegment) -> Vec<TextSegment> {
    if segment.chars.len() < 2 {
        return vec![segment];
    }
    let threshold = segment.height.max(segment.font_size).max(4.0) * 1.5;
    let is_ws = |c: &PdfCharBox| c.text.chars().all(char::is_whitespace);

    // Bornes [début, fin) des sous-parties, coupées entre deux caractères
    // visibles séparés par un blanc supérieur au seuil.
    let mut parts: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    let mut last_solid: Option<usize> = None;
    for index in 0..segment.chars.len() {
        if is_ws(&segment.chars[index]) {
            continue;
        }
        if let Some(prev) = last_solid {
            let a = &segment.chars[prev];
            let b = &segment.chars[index];
            // Les caractères d'une même ligne uniquement : un segment multi-lignes
            // ne doit pas être coupé sur le retour chariot (x repart à gauche).
            let same_line = (a.y - b.y).abs() <= a.height.max(b.height) * 0.6;
            let span = b.x - (a.x + a.width);
            if same_line && span > threshold {
                parts.push((start, prev + 1));
                start = index;
            }
        }
        last_solid = Some(index);
    }
    let end = last_solid.map(|i| i + 1).unwrap_or(segment.chars.len());
    parts.push((start, end));

    if parts.len() < 2 {
        return vec![segment];
    }

    parts
        .into_iter()
        .filter(|(s, e)| e > s)
        .map(|(s, e)| {
            let chars: Vec<PdfCharBox> = segment.chars[s..e].to_vec();
            let text: String = chars.iter().map(|c| c.text.as_str()).collect();
            let x = chars.iter().map(|c| c.x).fold(f64::INFINITY, f64::min);
            let y = chars.iter().map(|c| c.y).fold(f64::INFINITY, f64::min);
            let right = chars
                .iter()
                .map(|c| c.x + c.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = chars
                .iter()
                .map(|c| c.y + c.height)
                .fold(f64::NEG_INFINITY, f64::max);
            TextSegment {
                text: text.trim().to_string(),
                x,
                y,
                width: right - x,
                height: bottom - y,
                chars,
                ..segment.clone()
            }
        })
        .collect()
}

fn cluster_segments_into_lines(
    mut segments: Vec<TextSegment>,
    v_rules: &[(f64, f64, f64, f64)],
) -> Vec<TextSegment> {
    if segments.is_empty() {
        return segments;
    }

    segments.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut lines: Vec<Vec<TextSegment>> = Vec::new();
    for segment in segments {
        if let Some(line) = lines.last_mut() {
            let ref_seg = &line[0];
            let ref_center = ref_seg.y + ref_seg.height / 2.0;
            let seg_center = segment.y + segment.height / 2.0;
            let baseline_tol = (ref_seg.height.max(segment.height)) * 0.5;
            if (ref_center - seg_center).abs() <= baseline_tol {
                line.push(segment);
                continue;
            }
        }
        lines.push(vec![segment]);
    }

    let mut merged = Vec::with_capacity(lines.len());
    for mut line in lines {
        line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let mut groups: Vec<Vec<TextSegment>> = Vec::new();
        for segment in line {
            if let Some(group) = groups.last_mut() {
                let last = group.last().unwrap();
                let gap = segment.x - (last.x + last.width);
                let height_ref = last.height.max(segment.height);
                // Un trait vertical (bordure de cellule) entre les deux segments
                // signale deux cellules de tableau distinctes : jamais fusionnées.
                let seg_top = last.y.min(segment.y);
                let seg_bottom = (last.y + last.height).max(segment.y + segment.height);
                let separated_by_rule = v_rules.iter().any(|&(rx, ry, rw, rh)| {
                    let rule_x = rx + rw / 2.0;
                    rule_x > last.x + last.width - 1.0
                        && rule_x < segment.x + 1.0
                        && ry < seg_bottom
                        && ry + rh > seg_top
                });
                if gap <= height_ref * 1.2 && !separated_by_rule {
                    group.push(segment);
                    continue;
                }
            }
            groups.push(vec![segment]);
        }

        for group in groups {
            let x = group.iter().map(|s| s.x).fold(f64::INFINITY, f64::min);
            let y = group.iter().map(|s| s.y).fold(f64::INFINITY, f64::min);
            let right = group
                .iter()
                .map(|s| s.x + s.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = group
                .iter()
                .map(|s| s.y + s.height)
                .fold(f64::NEG_INFINITY, f64::max);
            let text = merge_segment_texts(&group);
            let bold = group.iter().filter(|s| s.bold).count() * 2 >= group.len();
            let italic = group.iter().filter(|s| s.italic).count() * 2 >= group.len();
            let serif = group.iter().filter(|s| s.serif).count() * 2 >= group.len();
            let font_size = group.iter().map(|s| s.font_size).fold(0.0_f64, f64::max);
            let font_name = group
                .iter()
                .find(|s| !s.font_name.is_empty())
                .map(|s| s.font_name.clone())
                .unwrap_or_default();
            let chars = merge_segment_chars(&group);
            merged.push(TextSegment {
                text,
                x,
                y,
                width: (right - x).max(1.0),
                height: (bottom - y).max(1.0),
                font_size,
                bold,
                italic,
                serif,
                font_name,
                justified: false,
                chars,
            });
        }
    }

    merged
}

/// Regroupe des lignes consécutives en paragraphes éditables d'un bloc.
/// Critères : même marge gauche, interligne régulier, taille de police proche.
/// On évite de fusionner colonnes/tableaux grâce à l'alignement gauche strict.
fn cluster_lines_into_paragraphs(
    mut lines: Vec<TextSegment>,
    h_rules: &[(f64, f64, f64, f64)],
) -> Vec<TextSegment> {
    if lines.len() < 2 {
        return lines;
    }
    lines.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    // Pour chaque ligne, on cherche le MEILLEUR groupe compatible (le plus proche
    // au-dessus, aligné à gauche) et pas seulement le dernier : les lignes d'un
    // paragraphe peuvent être entrecoupées par des cellules de tableau triées par y.
    let mut groups: Vec<Vec<TextSegment>> = Vec::new();
    for line in lines {
        let mut best_idx: Option<usize> = None;
        let mut best_prev_y = f64::NEG_INFINITY;
        for (gi, group) in groups.iter().enumerate() {
            let prev = group.last().unwrap();
            let ref_size = prev.font_size.max(line.font_size).max(1.0);
            let left_aligned = (prev.x - line.x).abs() <= (ref_size * 1.2).max(6.0);
            let pitch = line.y - prev.y;
            let regular_pitch = pitch > 0.0 && pitch <= ref_size * 2.4;
            let similar_size = (prev.font_size - line.font_size).abs() <= ref_size * 0.25;
            let prev_full = prev.width >= line.width * 0.4;
            // Deux lignes de styles différents (gras/italique/police) ne font jamais
            // partie du même paragraphe : un en-tête gras ("Code") suivi d'une valeur
            // normale ("V1") doit donner deux blocs distincts.
            let same_style = prev.bold == line.bold
                && prev.italic == line.italic
                && (prev.font_name.is_empty()
                    || line.font_name.is_empty()
                    || prev.font_name == line.font_name);
            // Un trait horizontal (bordure de rangée de tableau) entre les deux
            // lignes signale deux rangées distinctes : jamais le même paragraphe.
            let prev_bottom = prev.y + prev.height;
            let overlap_left = prev.x.max(line.x);
            let overlap_right = (prev.x + prev.width).min(line.x + line.width);
            let separated_by_rule = h_rules.iter().any(|&(rx, ry, rw, rh)| {
                let rule_y = ry + rh / 2.0;
                rule_y > prev_bottom - 1.0
                    && rule_y < line.y + 1.0
                    && rx < overlap_right
                    && rx + rw > overlap_left
            });
            if left_aligned
                && regular_pitch
                && similar_size
                && same_style
                && prev_full
                && !separated_by_rule
                && prev.y > best_prev_y
            {
                best_prev_y = prev.y;
                best_idx = Some(gi);
            }
        }
        match best_idx {
            Some(gi) => groups[gi].push(line),
            None => groups.push(vec![line]),
        }
    }

    groups
        .into_iter()
        .map(|group| {
            if group.len() == 1 {
                return group.into_iter().next().unwrap();
            }
            let x = group.iter().map(|s| s.x).fold(f64::INFINITY, f64::min);
            let y = group.iter().map(|s| s.y).fold(f64::INFINITY, f64::min);
            let right = group
                .iter()
                .map(|s| s.x + s.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = group
                .iter()
                .map(|s| s.y + s.height)
                .fold(f64::NEG_INFINITY, f64::max);
            let text = group
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let font_size = group.iter().map(|s| s.font_size).fold(0.0_f64, f64::max);
            let bold = group.iter().filter(|s| s.bold).count() * 2 >= group.len();
            let italic = group.iter().filter(|s| s.italic).count() * 2 >= group.len();
            let serif = group.iter().filter(|s| s.serif).count() * 2 >= group.len();
            let font_name = group
                .iter()
                .find(|s| !s.font_name.is_empty())
                .map(|s| s.font_name.clone())
                .unwrap_or_default();
            let chars = merge_segment_chars(&group);
            // Justifié : la plupart des lignes (hors dernière) remplissent ~toute la
            // largeur de colonne. On le reproduira en édition (text-align: justify)
            // pour coller au rendu du PDF.
            let max_width = group.iter().map(|s| s.width).fold(0.0_f64, f64::max);
            let n = group.len();
            let full_lines = group
                .iter()
                .take(n - 1)
                .filter(|s| max_width > 0.0 && s.width >= max_width * 0.9)
                .count();
            let justified = n >= 2 && full_lines * 2 >= (n - 1).max(1);
            TextSegment {
                text,
                x,
                y,
                width: (right - x).max(1.0),
                height: (bottom - y).max(1.0),
                font_size,
                bold,
                italic,
                serif,
                font_name,
                justified,
                chars,
            }
        })
        .collect()
}

fn font_weight_value(weight: &PdfFontWeight) -> u32 {
    match weight {
        PdfFontWeight::Weight100 => 100,
        PdfFontWeight::Weight200 => 200,
        PdfFontWeight::Weight300 => 300,
        PdfFontWeight::Weight400Normal => 400,
        PdfFontWeight::Weight500 => 500,
        PdfFontWeight::Weight600 => 600,
        PdfFontWeight::Weight700Bold => 700,
        PdfFontWeight::Weight800 => 800,
        PdfFontWeight::Weight900 => 900,
        PdfFontWeight::Custom(value) => *value,
    }
}

fn detect_segment_style(segment: &PdfPageTextSegment) -> (bool, bool, bool, String, f64) {
    let Ok(chars) = segment.chars() else {
        return (false, false, false, String::new(), 0.0);
    };
    for ch in chars.iter() {
        if ch.unicode_char().map(|c| c.is_whitespace()).unwrap_or(true) {
            continue;
        }
        let font_size = ch.scaled_font_size().value as f64;
        let raw_name = ch.font_name();
        let name = raw_name.to_lowercase();
        // NB : sur de nombreux PDF, FPDFText_GetFontWeight renvoie des valeurs
        // incohérentes (régulier > gras). Le nom de police PostScript est le
        // signal fiable. On garde le poids uniquement comme appoint très marqué.
        let weight_bold = ch
            .font_weight()
            .map(|w| font_weight_value(&w) >= 700)
            .unwrap_or(false)
            && (name.contains("bold") || name.contains("black") || name.contains("heavy"));
        let bold = weight_bold
            || ch.font_is_bold_reenforced()
            || name.contains("bold")
            || name.contains("black")
            || name.contains("heavy")
            || name.contains("semibold")
            || name.contains("-bd")
            || name.ends_with("bd");
        let italic = ch.font_is_italic() || name.contains("italic") || name.contains("oblique");
        let serif = ch.font_is_serif();
        return (bold, italic, serif, raw_name, font_size);
    }
    (false, false, false, String::new(), 0.0)
}

fn extract_segment_chars(segment: &PdfPageTextSegment, page_height: f64) -> Vec<PdfCharBox> {
    let Ok(chars) = segment.chars() else {
        return Vec::new();
    };

    let mut boxes = Vec::new();
    for ch in chars.iter() {
        let Some(value) = ch.unicode_char() else {
            continue;
        };
        if value == '\r' || value == '\n' {
            continue;
        }

        let loose = ch.loose_bounds().ok();
        let tight = ch.tight_bounds().ok();
        // Loose en priorité : hauteur uniforme par ligne et largeur d'avance des
        // espaces (le tight d'un espace est vide => le caractère disparaissait).
        let Some(main) = loose.as_ref().or(tight.as_ref()) else {
            continue;
        };
        let width = main.width().value as f64;
        let height = main.height().value as f64;
        if width <= 0.0 || height <= 0.0 {
            continue;
        }

        let mask = tight
            .as_ref()
            .filter(|rect| rect.width().value > 0.0 && rect.height().value > 0.0)
            .unwrap_or(main);

        boxes.push(PdfCharBox {
            text: value.to_string(),
            x: main.left().value as f64,
            y: page_height - main.top().value as f64,
            width,
            height,
            mask_x: mask.left().value as f64,
            mask_y: page_height - mask.top().value as f64,
            mask_width: mask.width().value as f64,
            mask_height: mask.height().value as f64,
        });
    }

    boxes.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    boxes
}

pub fn analyze_pdf_page(bytes: &[u8], page: u32) -> Result<PdfAnalysis, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    match analyze_with_pdfium(bytes, page) {
        Ok(analysis) => return Ok(analysis),
        Err(error) => {
            tracing::warn!(
                "PDFium analysis unavailable, falling back to frontend text scan: {error}"
            );
        }
    }

    Ok(PdfAnalysis {
        page,
        page_width: 0.0,
        page_height: 0.0,
        blocks: Vec::new(),
        engine: "alto-native-pdf-fallback".to_string(),
    })
}

fn analyze_with_pdfium(bytes: &[u8], page: u32) -> Result<PdfAnalysis, String> {
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_index = page
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
    let page = document
        .pages()
        .get(page_index)
        .map_err(|e| e.to_string())?;
    let page_width = page.width().value as f64;
    let page_height = page.height().value as f64;
    let text = page.text().map_err(|e| e.to_string())?;

    // Traits fins (bordures de tableau) : utilisés comme séparateurs pour ne
    // jamais fusionner deux cellules ou deux rangées dans un même bloc éditable.
    let mut h_rules: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut v_rules: Vec<(f64, f64, f64, f64)> = Vec::new();
    for object in page.objects().iter() {
        let kind = object.object_type();
        if kind == PdfPageObjectType::Text || kind == PdfPageObjectType::Image {
            continue;
        }
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let px = bounds.left().value as f64;
        let py = page_height - bounds.top().value as f64;
        let pw = bounds.width().value as f64;
        let ph = bounds.height().value as f64;
        if ph <= 2.5 && pw >= 10.0 {
            h_rules.push((px, py, pw, ph));
        } else if pw <= 2.5 && ph >= 6.0 {
            v_rules.push((px, py, pw, ph));
        } else if pw >= 10.0 && ph >= 6.0 {
            // Cellules de tableau dessinées comme des RECTANGLES au trait (et non
            // des lignes fines) : chaque arête visible devient un séparateur.
            let stroked = object
                .as_path_object()
                .map(|path| path.is_stroked().unwrap_or(false))
                .unwrap_or(false);
            let visible_stroke = object
                .stroke_color()
                .map(|c| c.alpha() > 0 && (c.red() < 240 || c.green() < 240 || c.blue() < 240))
                .unwrap_or(false);
            if stroked && visible_stroke {
                h_rules.push((px, py, pw, 0.0));
                h_rules.push((px, py + ph, pw, 0.0));
                v_rules.push((px, py, 0.0, ph));
                v_rules.push((px + pw, py, 0.0, ph));
            }
        }
    }

    let raw_segments: Vec<TextSegment> = text
        .segments()
        .iter()
        .filter_map(|segment| {
            let content = segment.text().trim().to_string();
            if content.is_empty() {
                return None;
            }
            let bounds = segment.bounds();
            let x = bounds.left().value as f64;
            let y = page_height - bounds.top().value as f64;
            let width = bounds.width().value as f64;
            let height = bounds.height().value as f64;
            if width <= 1.0 || height <= 1.0 {
                return None;
            }
            let (bold, italic, serif, font_name, font_size) = detect_segment_style(&segment);
            let chars = extract_segment_chars(&segment, page_height);
            Some(TextSegment {
                text: content,
                x,
                y,
                width,
                height,
                font_size,
                bold,
                italic,
                serif,
                font_name,
                justified: false,
                chars,
            })
        })
        .flat_map(split_segment_on_column_gaps)
        .collect();

    let lines = cluster_segments_into_lines(raw_segments, &v_rules);
    let mut blocks: Vec<PdfEditBlock> = cluster_lines_into_paragraphs(lines, &h_rules)
        .into_iter()
        .enumerate()
        .map(|(index, segment)| PdfEditBlock {
            id: format!("pdfium-{}-{index}", page_index + 1),
            kind: "text".to_string(),
            page: page_index as u32 + 1,
            text: segment.text,
            x: segment.x,
            y: segment.y,
            width: segment.width,
            height: segment.height,
            font_size: segment.font_size,
            bold: segment.bold,
            italic: segment.italic,
            serif: segment.serif,
            font_name: segment.font_name,
            justified: segment.justified,
            chars: segment.chars,
        })
        .collect();

    // Logos texte « multi-couches » : le même texte est estampé plusieurs fois
    // avec un léger décalage (faux gras), parfois via des glyphes sans
    // correspondance Unicode. La page texte de PDFium ne couvre que la couche
    // de base : on étend chaque bloc texte aux objets texte qui le chevauchent
    // presque entièrement, pour que le masque et l'instantané couvrent toutes
    // les couches (sinon, après déplacement, le bas des lettres reste visible
    // sous forme de petits tirets).
    for object in page.objects().iter() {
        if object.object_type() != PdfPageObjectType::Text {
            continue;
        }
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let ox = bounds.left().value as f64;
        let oy = page_height - bounds.top().value as f64;
        let ow = bounds.width().value as f64;
        let oh = bounds.height().value as f64;
        if ow <= 0.0 || oh <= 0.0 {
            continue;
        }
        let object_area = ow * oh;
        for block in blocks.iter_mut().filter(|b| b.kind == "text") {
            let inter_left = block.x.max(ox);
            let inter_top = block.y.max(oy);
            let inter_right = (block.x + block.width).min(ox + ow);
            let inter_bottom = (block.y + block.height).min(oy + oh);
            if inter_right <= inter_left || inter_bottom <= inter_top {
                continue;
            }
            let intersection = (inter_right - inter_left) * (inter_bottom - inter_top);
            if intersection < object_area * 0.6 {
                continue;
            }
            let new_x = block.x.min(ox);
            let new_y = block.y.min(oy);
            let new_right = (block.x + block.width).max(ox + ow);
            let new_bottom = (block.y + block.height).max(oy + oh);
            block.x = new_x;
            block.y = new_y;
            block.width = new_right - new_x;
            block.height = new_bottom - new_y;
            break;
        }
    }

    for (index, object) in page.objects().iter().enumerate() {
        if object.object_type() != PdfPageObjectType::Image {
            continue;
        }

        let Ok(bounds) = object.bounds() else {
            continue;
        };

        let x = bounds.left().value as f64;
        let y = page_height - bounds.top().value as f64;
        let width = bounds.width().value as f64;
        let height = bounds.height().value as f64;
        if width <= 2.0 || height <= 2.0 {
            continue;
        }
        // Un scan pleine page n'est pas une "image éditable" : la sélectionner
        // encadrerait toute la page (contour rouge). On la traite comme un fond.
        if width >= page_width * 0.85 && height >= page_height * 0.85 {
            continue;
        }

        blocks.push(PdfEditBlock {
            id: format!("pdfium-image-{}-{index}", page_index + 1),
            kind: "image".to_string(),
            page: page_index as u32 + 1,
            text: "Image".to_string(),
            x,
            y,
            width,
            height,
            font_size: 0.0,
            bold: false,
            italic: false,
            serif: false,
            font_name: String::new(),
            justified: false,
            chars: Vec::new(),
        });
    }

    // Les logos sont souvent composés d'une image + de petits tracés vectoriels
    // (soulignement, swoosh, tirets décoratifs). On étend le bloc image pour les
    // inclure : déplacer le « logo » déplace alors l'ensemble, et le masque de
    // l'ancienne position couvre tout (sinon les tirets restent en place).
    let mut path_boxes: Vec<(f64, f64, f64, f64)> = Vec::new();
    for object in page.objects().iter() {
        // Tout sauf texte et images : tracés, dégradés, fragments de formulaire
        // (les logos Illustrator emballent souvent leurs éléments dans des
        // XObjects de type Form, pas dans des Path simples).
        let kind = object.object_type();
        if kind == PdfPageObjectType::Text || kind == PdfPageObjectType::Image {
            continue;
        }
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let px = bounds.left().value as f64;
        let py = page_height - bounds.top().value as f64;
        let pw = bounds.width().value as f64;
        let ph = bounds.height().value as f64;
        if pw <= 0.5 && ph <= 0.5 {
            continue;
        }
        // Règles, bordures de tableau et cadres pleine page : jamais absorbés.
        if pw >= page_width * 0.6 || ph >= page_height * 0.6 {
            continue;
        }
        path_boxes.push((px, py, pw, ph));
    }

    for block in blocks.iter_mut().filter(|b| b.kind == "image") {
        let base_width = block.width;
        let base_height = block.height;
        let max_area = (base_width * base_height) * 4.0;
        const GAP: f64 = 18.0;
        let mut changed = true;
        while changed {
            changed = false;
            for &(px, py, pw, ph) in &path_boxes {
                // Seuls les petits tracés à l'échelle du logo d'origine sont absorbés.
                if pw > base_width * 2.0 || ph > base_height * 2.0 {
                    continue;
                }
                let near_x = px < block.x + block.width + GAP && px + pw > block.x - GAP;
                let near_y = py < block.y + block.height + GAP && py + ph > block.y - GAP;
                if !near_x || !near_y {
                    continue;
                }
                let nx = block.x.min(px);
                let ny = block.y.min(py);
                let nr = (block.x + block.width).max(px + pw);
                let nb = (block.y + block.height).max(py + ph);
                if (nr - nx) * (nb - ny) > max_area {
                    continue;
                }
                if nx < block.x - 0.01
                    || ny < block.y - 0.01
                    || nr > block.x + block.width + 0.01
                    || nb > block.y + block.height + 0.01
                {
                    block.x = nx;
                    block.y = ny;
                    block.width = nr - nx;
                    block.height = nb - ny;
                    changed = true;
                }
            }
        }
    }

    Ok(PdfAnalysis {
        page: page_index as u32 + 1,
        page_width,
        page_height,
        blocks,
        engine: "pdfium".to_string(),
    })
}

pub fn export_flattened_pdf(pages: Vec<FlattenedPage>) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("No rendered pages were provided for export.".to_string());
    }

    let mut objects = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());

    let page_count = pages.len();
    let kids = (0..page_count)
        .map(|index| format!("{} 0 R", 3 + index * 3))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!("<< /Type /Pages /Count {page_count} /Kids [{kids}] >>").into_bytes());

    for (index, page) in pages.into_iter().enumerate() {
        if page.jpeg_bytes.is_empty() {
            return Err("A rendered page image is empty.".to_string());
        }

        let page_object_id = 3 + index * 3;
        let image_object_id = page_object_id + 1;
        let content_object_id = page_object_id + 2;
        let image_name = format!("Im{}", index + 1);
        let width = page.width.max(1.0);
        let height = page.height.max(1.0);

        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2} {height:.2}] /Resources << /XObject << /{image_name} {image_object_id} 0 R >> >> /Contents {content_object_id} 0 R >>"
            )
            .into_bytes(),
        );

        let mut image_object = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            width.round() as u32,
            height.round() as u32,
            page.jpeg_bytes.len()
        )
        .into_bytes();
        image_object.extend(page.jpeg_bytes);
        image_object.extend(b"\nendstream");
        objects.push(image_object);

        let content = format!("q\n{width:.2} 0 0 {height:.2} 0 0 cm\n/{image_name} Do\nQ\n");
        objects.push(
            format!(
                "<< /Length {} >>\nstream\n{}endstream",
                content.len(),
                content
            )
            .into_bytes(),
        );
    }

    Ok(write_pdf(objects))
}

fn write_pdf(objects: Vec<Vec<u8>>) -> Vec<u8> {
    let mut pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len() + 1);
    offsets.push(0usize);

    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend(object);
        pdf.extend(b"\nendobj\n");
    }

    let xref_offset = pdf.len();
    pdf.extend(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend(b"0000000000 65535 f \n");
    for offset in offsets.iter().skip(1) {
        pdf.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }

    pdf.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );

    pdf
}

/// Répare un PDF en le rechargeant via PDFium (parseur tolérant) puis en le
/// réécrivant : reconstruit la table xref, normalise les flux et les objets.
pub fn repair_pdf(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| format!("Unable to read this PDF: {e}"))?;
    if document.pages().is_empty() {
        return Err("This PDF has no readable page.".to_string());
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

/// Détecte les pages réellement blanches (rendu quasi entièrement blanc) et
/// renvoie le PDF nettoyé + la liste 1-indexée des pages retirées.
/// Conservateur : seuil très bas pour ne jamais supprimer une page utile.
pub fn remove_blank_pages(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u32>), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    let (blanks, total) = {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        let total = document.pages().len() as usize;
        let mut blanks = Vec::new();
        for (index, page) in document.pages().iter().enumerate() {
            let rendered = page
                .render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_width(160)
                        .render_form_data(true),
                )
                .map_err(|e| e.to_string())?
                .as_image()
                .map_err(|e| e.to_string())?
                .to_luma8();
            let pixel_count = (rendered.width() * rendered.height()).max(1) as f64;
            let mut marked = 0u64;
            for pixel in rendered.pixels() {
                if pixel[0] < 245 {
                    marked += 1;
                }
            }
            if (marked as f64 / pixel_count) < 0.002 {
                blanks.push(index as u32 + 1);
            }
        }
        (blanks, total)
    };

    if blanks.is_empty() {
        return Ok((bytes.to_vec(), blanks));
    }
    if blanks.len() >= total {
        return Err("Every page looks blank: nothing was removed.".to_string());
    }

    let out = crate::pdf_ops::delete_pages(bytes.to_vec(), blanks.clone())?;
    Ok((out, blanks))
}
