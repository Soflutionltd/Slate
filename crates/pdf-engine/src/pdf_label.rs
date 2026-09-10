//! Analyse d'étiquettes : bounding box du contenu et découpage en blocs.
//!
//! Sert à l'impression d'étiquettes d'expédition sur imprimante thermique. Un
//! label DHL Express fait 110 × 210 mm ; le papier thermique 4×6 pouces mesure
//! 101,6 × 152,4 mm. Mis à l'échelle brutalement, le contenu tombe à 72 % et
//! les codes-barres deviennent difficiles à scanner.
//!
//! Deux mesures corrigent ça, et cette analyse fournit les deux :
//!   - la bounding box du contenu, pour supprimer les marges blanches ;
//!   - les blocs de contenu séparés par des bandes horizontales vides, pour
//!     resserrer ces bandes sans rien perdre. Sur un label DHL réel, les
//!     35 mm de vide interne ramenés à 2 mm par bande font passer l'échelle
//!     de 72 % à 96 %.
//!
//! Le rendu se fait via PDFium, déjà présent : aucune dépendance nouvelle.

use pdfium_render::prelude::*;

use crate::pdf_engine::pdfium_guard;

/// Au-delà de cette luminance, le pixel est considéré comme blanc.
const WHITE_THRESHOLD: u8 = 250;
/// Nombre minimal de pixels d'encre pour qu'une ligne ou colonne compte : en
/// dessous, c'est du bruit de compression JPEG, pas du contenu.
const MIN_INK_PIXELS: u32 = 2;
/// Marge de sécurité ajoutée autour de la bbox, en points.
const SAFETY_MARGIN_PT: f32 = 2.0;

/// Rectangle en points PDF, origine en bas à gauche.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl LabelBox {
    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }
}

/// Un bloc de contenu : bande horizontale non vide, en points PDF.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBand {
    /// Bord inférieur du bloc, en points depuis le bas de la page.
    pub y0: f32,
    /// Bord supérieur du bloc.
    pub y1: f32,
}

impl ContentBand {
    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }
}

/// Résultat de l'analyse d'une page.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelLayout {
    /// Dimensions de la page source, en points.
    pub page_width: f32,
    pub page_height: f32,
    /// Bounding box du contenu, marge de sécurité incluse.
    pub content: LabelBox,
    /// Blocs de contenu, du bas vers le haut de la page.
    pub bands: Vec<ContentBand>,
}

impl LabelLayout {
    /// Hauteur totale du contenu si les bandes vides sont ramenées à `gap_pt`.
    pub fn compacted_height(&self, gap_pt: f32) -> f32 {
        if self.bands.is_empty() {
            return self.content.height();
        }
        let ink: f32 = self.bands.iter().map(ContentBand::height).sum();
        ink + gap_pt * (self.bands.len() - 1) as f32
    }
}

/// Analyse une page et renvoie sa bbox de contenu et ses blocs.
///
/// `dpi` fixe la finesse du rendu (72 suffit largement pour une bbox).
/// `min_gutter_pt` est la hauteur minimale d'une bande vide pour qu'elle sépare
/// deux blocs : en dessous, c'est un interligne, pas une gouttière.
pub fn analyze_label_page(
    bytes: &[u8],
    page_number: u32,
    dpi: f32,
    min_gutter_pt: f32,
) -> Result<LabelLayout, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Le document à analyser n'est pas un PDF valide.".to_string());
    }
    if !(dpi >= 36.0) || !(dpi <= 300.0) {
        return Err("Résolution d'analyse hors plage (36 à 300 dpi).".to_string());
    }

    let guard = pdfium_guard()?;
    let document = guard
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_index = page_number
        .checked_sub(1)
        .ok_or_else(|| "Les pages sont numérotées à partir de 1.".to_string())? as i32;
    let page = document
        .pages()
        .get(page_index)
        .map_err(|e| e.to_string())?;

    let page_width = page.width().value;
    let page_height = page.height().value;
    if page_width <= 0.0 || page_height <= 0.0 {
        return Err("Dimensions de page invalides.".to_string());
    }

    let target_width = ((page_width * dpi / 72.0).round() as i32).clamp(16, 4000);
    let rendered = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(target_width)
                .render_form_data(true),
        )
        .map_err(|e| e.to_string())?
        .as_image()
        .map_err(|e| e.to_string())?;

    // PDFium rend avec un canal alpha. Convertir directement en niveaux de gris
    // interpréterait le fond transparent comme du noir, donc TOUTE la page
    // passerait pour de l'encre et la bbox couvrirait la feuille entière.
    // On compose donc explicitement sur blanc.
    let rgba = rendered.to_rgba8();
    let (width_px, height_px) = (rgba.width(), rgba.height());
    if width_px == 0 || height_px == 0 {
        return Err("Rendu d'analyse vide.".to_string());
    }

    let mut row_ink = vec![0_u32; height_px as usize];
    let mut col_ink = vec![0_u32; width_px as usize];
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = a as u32;
        // Composition sur blanc : c = c_src·α + 255·(1-α).
        let blend = |channel: u8| ((channel as u32 * alpha + 255 * (255 - alpha)) / 255) as u32;
        // Luminance BT.601, suffisante pour distinguer encre et papier.
        let luma = (299 * blend(r) + 587 * blend(g) + 114 * blend(b)) / 1000;
        if luma <= WHITE_THRESHOLD as u32 {
            row_ink[y as usize] += 1;
            col_ink[x as usize] += 1;
        }
    }

    let rows: Vec<bool> = row_ink.iter().map(|n| *n >= MIN_INK_PIXELS).collect();
    let cols: Vec<bool> = col_ink.iter().map(|n| *n >= MIN_INK_PIXELS).collect();

    let first_row = rows.iter().position(|inked| *inked);
    let last_row = rows.iter().rposition(|inked| *inked);
    let first_col = cols.iter().position(|inked| *inked);
    let last_col = cols.iter().rposition(|inked| *inked);

    // Page vide : on renvoie la page entière plutôt que de faire échouer
    // l'impression sur un document sans contenu détectable.
    let (Some(first_row), Some(last_row), Some(first_col), Some(last_col)) =
        (first_row, last_row, first_col, last_col)
    else {
        return Ok(LabelLayout {
            page_width,
            page_height,
            content: LabelBox {
                x0: 0.0,
                y0: 0.0,
                x1: page_width,
                y1: page_height,
            },
            bands: vec![ContentBand {
                y0: 0.0,
                y1: page_height,
            }],
        });
    };

    let px_to_pt_x = page_width / width_px as f32;
    let px_to_pt_y = page_height / height_px as f32;
    // Le bitmap a son origine en haut à gauche, le PDF en bas à gauche.
    let to_pdf_y = |row: usize| page_height - (row as f32 + 1.0) * px_to_pt_y;

    let content = LabelBox {
        x0: (first_col as f32 * px_to_pt_x - SAFETY_MARGIN_PT).max(0.0),
        y0: (to_pdf_y(last_row) - SAFETY_MARGIN_PT).max(0.0),
        x1: ((last_col as f32 + 1.0) * px_to_pt_x + SAFETY_MARGIN_PT).min(page_width),
        y1: (to_pdf_y(first_row) + px_to_pt_y + SAFETY_MARGIN_PT).min(page_height),
    };

    let bands = detect_bands(
        &rows[first_row..=last_row],
        first_row,
        px_to_pt_y,
        page_height,
        min_gutter_pt,
        content,
    );

    Ok(LabelLayout {
        page_width,
        page_height,
        content,
        bands,
    })
}

/// Regroupe les lignes encrées en blocs, séparés par les gouttières franches.
fn detect_bands(
    rows: &[bool],
    row_offset: usize,
    px_to_pt_y: f32,
    page_height: f32,
    min_gutter_pt: f32,
    content: LabelBox,
) -> Vec<ContentBand> {
    let min_gutter_px = if min_gutter_pt <= 0.0 {
        usize::MAX
    } else {
        ((min_gutter_pt / px_to_pt_y).round() as usize).max(1)
    };

    // Bornes de blocs en index de ligne bitmap (haut vers bas).
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    let mut last_inked = 0_usize;
    let mut gap = 0_usize;
    for (index, inked) in rows.iter().enumerate() {
        if *inked {
            if start.is_none() {
                start = Some(index);
            }
            last_inked = index;
            gap = 0;
        } else {
            gap += 1;
            if start.is_some() && gap >= min_gutter_px {
                spans.push((start.take().unwrap(), last_inked));
                gap = 0;
            }
        }
    }
    if let Some(begin) = start {
        spans.push((begin, last_inked));
    }
    if spans.is_empty() {
        return vec![ContentBand {
            y0: content.y0,
            y1: content.y1,
        }];
    }

    // Conversion en points PDF. Les index bitmap descendent quand y PDF monte,
    // donc l'ordre est inversé pour rendre les blocs du bas vers le haut.
    let mut bands: Vec<ContentBand> = spans
        .into_iter()
        .map(|(top, bottom)| {
            let y1 = page_height - (row_offset + top) as f32 * px_to_pt_y;
            let y0 = page_height - (row_offset + bottom + 1) as f32 * px_to_pt_y;
            ContentBand {
                y0: y0.max(0.0),
                y1: y1.min(page_height),
            }
        })
        .collect();
    bands.sort_by(|left, right| left.y0.total_cmp(&right.y0));

    // La marge de sécurité s'applique aussi aux extrémités du contenu, sinon un
    // glyphe rasé au pixel près serait tronqué après recadrage.
    if let Some(first) = bands.first_mut() {
        first.y0 = (first.y0 - SAFETY_MARGIN_PT).max(content.y0);
    }
    if let Some(last) = bands.last_mut() {
        last.y1 = (last.y1 + SAFETY_MARGIN_PT).min(content.y1);
    }
    bands
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacted_height_sums_bands_and_gaps() {
        let layout = LabelLayout {
            page_width: 311.8,
            page_height: 595.3,
            content: LabelBox {
                x0: 0.0,
                y0: 0.0,
                x1: 311.8,
                y1: 595.3,
            },
            bands: vec![
                ContentBand { y0: 0.0, y1: 100.0 },
                ContentBand {
                    y0: 200.0,
                    y1: 300.0,
                },
                ContentBand {
                    y0: 400.0,
                    y1: 450.0,
                },
            ],
        };
        // 100 + 100 + 50 d'encre, plus deux gouttières de 6 pt.
        assert!((layout.compacted_height(6.0) - 262.0).abs() < 0.01);
    }

    #[test]
    fn compacted_height_without_bands_falls_back_to_content() {
        let layout = LabelLayout {
            page_width: 100.0,
            page_height: 200.0,
            content: LabelBox {
                x0: 0.0,
                y0: 10.0,
                x1: 100.0,
                y1: 190.0,
            },
            bands: Vec::new(),
        };
        assert!((layout.compacted_height(6.0) - 180.0).abs() < 0.01);
    }

    #[test]
    fn detect_bands_splits_on_wide_gutters_only() {
        // 1 pt par pixel : 4 lignes encrées, 8 vides, 4 encrées.
        let mut rows = vec![true; 4];
        rows.extend(vec![false; 8]);
        rows.extend(vec![true; 4]);
        let content = LabelBox {
            x0: 0.0,
            y0: 0.0,
            x1: 50.0,
            y1: 16.0,
        };

        // Gouttière minimale de 4 pt : les 8 pt de vide séparent bien.
        let split = detect_bands(&rows, 0, 1.0, 16.0, 4.0, content);
        assert_eq!(split.len(), 2, "deux blocs attendus, obtenu {split:?}");

        // Gouttière minimale de 12 pt : le vide est trop court, un seul bloc.
        let merged = detect_bands(&rows, 0, 1.0, 12.0, content.y1, content);
        assert_eq!(merged.len(), 1, "un seul bloc attendu, obtenu {merged:?}");
    }

    #[test]
    fn detect_bands_orders_from_bottom_to_top() {
        let mut rows = vec![true; 2];
        rows.extend(vec![false; 6]);
        rows.extend(vec![true; 2]);
        let content = LabelBox {
            x0: 0.0,
            y0: 0.0,
            x1: 50.0,
            y1: 10.0,
        };
        let bands = detect_bands(&rows, 0, 1.0, 10.0, 4.0, content);
        assert_eq!(bands.len(), 2);
        assert!(
            bands[0].y0 < bands[1].y0,
            "les blocs doivent monter : {bands:?}"
        );
    }

    #[test]
    fn detect_bands_never_returns_empty() {
        let content = LabelBox {
            x0: 0.0,
            y0: 5.0,
            x1: 50.0,
            y1: 45.0,
        };
        let bands = detect_bands(&[false; 10], 0, 1.0, 50.0, 4.0, content);
        assert_eq!(bands.len(), 1);
        assert!((bands[0].y0 - 5.0).abs() < 0.01);
        assert!((bands[0].y1 - 45.0).abs() < 0.01);
    }

    #[test]
    fn analyze_rejects_non_pdf_and_bad_dpi() {
        assert!(analyze_label_page(b"not a pdf", 1, 72.0, 8.0).is_err());
        assert!(analyze_label_page(b"%PDF-1.4\n", 1, 5.0, 8.0).is_err());
        assert!(analyze_label_page(b"%PDF-1.4\n", 1, 900.0, 8.0).is_err());
    }
}
