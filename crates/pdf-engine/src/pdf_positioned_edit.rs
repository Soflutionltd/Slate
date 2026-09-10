//! Repli PDFium positionné pour les objets texte simples.
//!
//! Le splice `lopdf` reste le chemin prioritaire. Ce module n'intervient que
//! lorsque `FPDFText_SetText` a produit un texte exact mais détruit le crénage
//! interne (`layout_divergence`). Il rejoue alors la même édition sur le
//! document original et restaure explicitement les positions de caractères via
//! `FPDFText_SetPositions`, sans modifier le flux chirurgical existant.

use crate::pdf_engine::{
    analyze_pdf_page, pdfium_guard, render_pdf_page_png, strip_whitespace, NativeTextEditOutcome,
    NativeTextEditReport,
};
use pdfium_render::prelude::*;
use std::collections::BTreeSet;

const POSITION_TOLERANCE_PT: f64 = 0.35;

#[derive(Clone, Copy)]
enum CharSource {
    Retained { old_ordinal: usize, suffix: bool },
    Inserted,
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn translated(self, delta: Point) -> Self {
        Self {
            x: self.x + delta.x,
            y: self.y + delta.y,
        }
    }

    fn offset_from(self, origin: Point) -> Self {
        Self {
            x: self.x - origin.x,
            y: self.y - origin.y,
        }
    }
}

/// Construit les origines page souhaitées :
/// - préfixe strictement immobile ;
/// - caractères insérés espacés selon le layout PDFium temporaire ;
/// - suffixe translaté uniformément, donc crénage original préservé.
fn desired_origins(
    old_origins: &[Point],
    temporary_origins: &[Point],
    sources: &[CharSource],
) -> Result<Vec<Point>, String> {
    if temporary_origins.len() != sources.len() || old_origins.is_empty() || sources.is_empty() {
        return Err("positioned_origin_count".to_string());
    }

    let prefix_count = sources
        .iter()
        .take_while(|source| matches!(source, CharSource::Retained { suffix: false, .. }))
        .count();
    let suffix_start = sources
        .iter()
        .position(|source| matches!(source, CharSource::Retained { suffix: true, .. }));

    let mut desired = vec![Point { x: 0.0, y: 0.0 }; sources.len()];
    for (new_ordinal, source) in sources.iter().take(prefix_count).enumerate() {
        let CharSource::Retained { old_ordinal, .. } = source else {
            return Err("positioned_prefix_mapping".to_string());
        };
        desired[new_ordinal] = old_origins[*old_ordinal];
    }

    let (anchor_new, anchor_page) = if prefix_count > 0 {
        (prefix_count - 1, desired[prefix_count - 1])
    } else {
        // Insertion ou suppression en début d'objet : le premier nouveau
        // caractère reprend l'origine du premier ancien caractère.
        (0, old_origins[0])
    };
    let temporary_anchor = temporary_origins[anchor_new];

    let inserted_end = suffix_start.unwrap_or(sources.len());
    for new_ordinal in prefix_count..inserted_end {
        desired[new_ordinal] =
            anchor_page.translated(temporary_origins[new_ordinal].offset_from(temporary_anchor));
    }

    if let Some(start) = suffix_start {
        let candidate =
            anchor_page.translated(temporary_origins[start].offset_from(temporary_anchor));
        let CharSource::Retained {
            old_ordinal: first_old_suffix,
            ..
        } = sources[start]
        else {
            return Err("positioned_suffix_mapping".to_string());
        };
        let suffix_delta = candidate.offset_from(old_origins[first_old_suffix]);
        for (new_ordinal, source) in sources.iter().enumerate().skip(start) {
            let CharSource::Retained { old_ordinal, .. } = source else {
                return Err("positioned_suffix_mapping".to_string());
            };
            desired[new_ordinal] = old_origins[*old_ordinal].translated(suffix_delta);
        }
    }

    Ok(desired)
}

fn positions_in_object_space(
    matrix: PdfMatrix,
    desired: &[Point],
    temporary: &[Point],
) -> Result<Vec<f32>, String> {
    if desired.len() <= 1 {
        return Ok(Vec::new());
    }
    if matrix.determinant().abs() < 1e-7 {
        return Err("positioned_singular_matrix".to_string());
    }
    let inverse = matrix.invert();
    let to_local = |point: Point| {
        let (x, y) = inverse.apply_to_points(
            PdfPoints::new(point.x as f32),
            PdfPoints::new(point.y as f32),
        );
        Point {
            x: x.value as f64,
            y: y.value as f64,
        }
    };
    let desired_local: Vec<Point> = desired.iter().copied().map(to_local).collect();
    let temporary_local: Vec<Point> = temporary.iter().copied().map(to_local).collect();

    let span = |values: &[Point], x_axis: bool| {
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for point in values {
            let value = if x_axis { point.x } else { point.y };
            min = min.min(value);
            max = max.max(value);
        }
        max - min
    };
    let horizontal = span(&temporary_local, true) >= span(&temporary_local, false);
    let axis = |point: Point| if horizontal { point.x } else { point.y };
    let cross = |point: Point| if horizontal { point.y } else { point.x };
    let cross_origin = cross(desired_local[0]);
    if desired_local
        .iter()
        .any(|point| (cross(*point) - cross_origin).abs() > POSITION_TOLERANCE_PT)
    {
        return Err("positioned_multiline_object".to_string());
    }

    let first = axis(desired_local[0]);
    Ok(desired_local
        .iter()
        .skip(1)
        .map(|point| (axis(*point) - first) as f32)
        .collect())
}

fn page_text_without_whitespace(page: &PdfPage) -> Result<String, String> {
    let text = page.text().map_err(|error| error.to_string())?;
    let chars = text.chars();
    let mut output = String::new();
    for index in 0..chars.len() {
        if let Ok(character) = chars.get(index) {
            if let Some(unicode) = character.unicode_char() {
                if !unicode.is_whitespace() {
                    output.push(unicode);
                }
            }
        }
    }
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn edit_pdf_text_positioned(
    bytes: &[u8],
    page_number: u32,
    removed_char_indices: &[u32],
    insert_after_char_index: i64,
    insert_before_char_index: i64,
    inserted: &str,
    scale: f64,
) -> Result<NativeTextEditOutcome, String> {
    if inserted.contains('\n') || inserted.contains('\r') {
        return Err("positioned_multiline_insert".to_string());
    }
    let removed: BTreeSet<i64> = removed_char_indices
        .iter()
        .map(|index| *index as i64)
        .collect();
    let mut anchors: Vec<i64> = removed.iter().copied().collect();
    if insert_after_char_index >= 0 {
        anchors.push(insert_after_char_index);
    }
    if insert_before_char_index >= 0 {
        anchors.push(insert_before_char_index);
    }
    if anchors.is_empty() {
        return Err("positioned_no_anchor".to_string());
    }

    let output_bytes = {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let page_index = page_number
            .checked_sub(1)
            .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
        let original = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|error| error.to_string())?;
        let page = original
            .pages()
            .get(page_index)
            .map_err(|error| error.to_string())?;
        let before_page = page_text_without_whitespace(&page)?;
        let text = page.text().map_err(|error| error.to_string())?;
        let all_chars = text.chars();
        let mut anchor_rects = Vec::new();
        for index in &anchors {
            let character = all_chars
                .get(*index as usize)
                .map_err(|_| "positioned_char_index".to_string())?;
            let bounds = character
                .loose_bounds()
                .map_err(|_| "positioned_char_bounds".to_string())?;
            anchor_rects.push(bounds);
        }

        let mut target = None;
        for (object_index, object) in page.objects().iter().enumerate() {
            let Some(text_object) = object.as_text_object() else {
                continue;
            };
            let bounds = object.bounds().map_err(|error| error.to_string())?;
            let touches = anchor_rects.iter().any(|anchor| {
                anchor.left().value < bounds.right().value + 2.0
                    && anchor.right().value > bounds.left().value - 2.0
                    && anchor.bottom().value < bounds.top().value + 2.0
                    && anchor.top().value > bounds.bottom().value - 2.0
            });
            if !touches {
                continue;
            }
            let chars = text
                .chars_for_object(text_object)
                .map_err(|error| error.to_string())?;
            let indices: BTreeSet<i64> = chars
                .iter()
                .map(|character| character.index() as i64)
                .collect();
            if !anchors.iter().all(|index| indices.contains(index)) {
                if anchors.iter().any(|index| indices.contains(index)) {
                    return Err("positioned_multi_object_edit".to_string());
                }
                continue;
            }

            let mut old_chars = Vec::new();
            let mut old_origins = Vec::new();
            for character in chars.iter() {
                let unicode = character
                    .unicode_char()
                    .ok_or_else(|| "positioned_unmapped_glyph".to_string())?;
                let (x, y) = character
                    .origin()
                    .map_err(|_| "positioned_char_origin".to_string())?;
                old_chars.push((character.index() as i64, unicode));
                old_origins.push(Point {
                    x: x.value as f64,
                    y: y.value as f64,
                });
            }
            target = Some((
                object_index,
                object.matrix().map_err(|error| error.to_string())?,
                old_chars,
                old_origins,
            ));
            break;
        }
        let (object_index, matrix, old_chars, old_origins) =
            target.ok_or_else(|| "positioned_text_object_not_found".to_string())?;
        let removed_ordinals: Vec<usize> = old_chars
            .iter()
            .enumerate()
            .filter_map(|(ordinal, (index, _))| removed.contains(index).then_some(ordinal))
            .collect();
        if removed_ordinals.len() != removed.len()
            || removed_ordinals
                .windows(2)
                .any(|pair| pair[1] != pair[0] + 1)
        {
            // Un delta unique ne suffit pas à refermer plusieurs trous
            // indépendants. Le chemin historique reste alors seul autorisé.
            return Err("positioned_non_contiguous_delete".to_string());
        }

        let first_removed = removed.iter().next().copied();
        let is_suffix = |index: i64| {
            first_removed.is_some_and(|removed_index| index > removed_index)
                || insert_before_char_index >= 0 && index >= insert_before_char_index
                || insert_after_char_index >= 0 && index > insert_after_char_index
        };
        let mut new_text = String::new();
        let mut sources = Vec::new();
        let mut insertion_done = false;
        for (old_ordinal, (index, unicode)) in old_chars.iter().copied().enumerate() {
            if !insertion_done && insert_after_char_index < 0 && insert_before_char_index == index {
                for character in inserted.chars() {
                    new_text.push(character);
                    sources.push(CharSource::Inserted);
                }
                insertion_done = true;
            }
            if !removed.contains(&index) {
                new_text.push(unicode);
                sources.push(CharSource::Retained {
                    old_ordinal,
                    suffix: is_suffix(index),
                });
            }
            if !insertion_done && insert_after_char_index == index {
                for character in inserted.chars() {
                    new_text.push(character);
                    sources.push(CharSource::Inserted);
                }
                insertion_done = true;
            }
        }
        if !inserted.is_empty() && !insertion_done {
            for character in inserted.chars() {
                new_text.push(character);
                sources.push(CharSource::Inserted);
            }
        }
        if new_text.is_empty() || sources.len() <= 1 {
            return Err("positioned_too_few_characters".to_string());
        }
        let expected_object = strip_whitespace(&new_text);

        let expected_page = {
            let mut output = String::new();
            let mut insertion_emitted = false;
            let before_text = page.text().map_err(|error| error.to_string())?;
            let before_chars = before_text.chars();
            for ordinal in 0..before_chars.len() {
                let character = before_chars
                    .get(ordinal)
                    .map_err(|_| "positioned_page_char".to_string())?;
                let index = character.index() as i64;
                let Some(unicode) = character.unicode_char() else {
                    continue;
                };
                if !insertion_emitted
                    && insert_after_char_index < 0
                    && insert_before_char_index == index
                {
                    output.push_str(inserted);
                    insertion_emitted = true;
                }
                if !removed.contains(&index) {
                    output.push(unicode);
                }
                if !insertion_emitted && insert_after_char_index == index {
                    output.push_str(inserted);
                    insertion_emitted = true;
                }
            }
            if !inserted.is_empty() && !insertion_emitted {
                output.push_str(inserted);
            }
            strip_whitespace(&output)
        };
        if before_page.is_empty() || expected_page.is_empty() {
            return Err("positioned_empty_page".to_string());
        }

        // Première passe : PDFium fournit les avances naturelles des nouveaux
        // glyphes. Le résultat n'est jamais exposé à l'appelant.
        let mut temporary_page = original
            .pages()
            .get(page_index)
            .map_err(|error| error.to_string())?;
        let mut changed = false;
        for (index, mut object) in temporary_page.objects().iter().enumerate() {
            if index != object_index {
                continue;
            }
            object
                .as_text_object_mut()
                .ok_or_else(|| "positioned_text_object_not_found".to_string())?
                .set_text(&new_text)
                .map_err(|error| error.to_string())?;
            changed = true;
            break;
        }
        if !changed {
            return Err("positioned_text_object_not_found".to_string());
        }
        temporary_page
            .regenerate_content()
            .map_err(|error| error.to_string())?;
        drop(temporary_page);
        let temporary_bytes = original
            .save_to_bytes()
            .map_err(|error| error.to_string())?;

        let (desired, positions) = {
            let temporary_document = pdfium
                .load_pdf_from_byte_slice(&temporary_bytes, None)
                .map_err(|error| error.to_string())?;
            let temporary_page = temporary_document
                .pages()
                .get(page_index)
                .map_err(|error| error.to_string())?;
            let temporary_text = temporary_page.text().map_err(|error| error.to_string())?;
            let temporary_object = temporary_page
                .objects()
                .iter()
                .nth(object_index)
                .ok_or_else(|| "positioned_text_object_not_found".to_string())?;
            let temporary_text_object = temporary_object
                .as_text_object()
                .ok_or_else(|| "positioned_text_object_not_found".to_string())?;
            if strip_whitespace(&temporary_text.for_object(temporary_text_object))
                != expected_object
            {
                return Err("positioned_missing_glyphs".to_string());
            }
            let temporary_chars = temporary_text
                .chars_for_object(temporary_text_object)
                .map_err(|error| error.to_string())?;
            let mut temporary_origins = Vec::new();
            for character in temporary_chars.iter() {
                let (x, y) = character
                    .origin()
                    .map_err(|_| "positioned_char_origin".to_string())?;
                temporary_origins.push(Point {
                    x: x.value as f64,
                    y: y.value as f64,
                });
            }
            if temporary_origins.len() != sources.len() {
                return Err("positioned_origin_count".to_string());
            }

            let desired = desired_origins(&old_origins, &temporary_origins, &sources)?;
            let positions = positions_in_object_space(matrix, &desired, &temporary_origins)?;
            (desired, positions)
        };

        // Deuxième passe, depuis les octets ORIGINAUX : aucun résultat de la
        // passe de mesure ne peut fuiter dans le document final.
        let final_document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|error| error.to_string())?;
        let mut final_page = final_document
            .pages()
            .get(page_index)
            .map_err(|error| error.to_string())?;
        let bindings = pdfium.bindings();
        let mut positioned = false;
        for (index, mut object) in final_page.objects().iter().enumerate() {
            if index != object_index {
                continue;
            }
            let handle = bindings.get_handle_from_object(&object);
            object
                .as_text_object_mut()
                .ok_or_else(|| "positioned_text_object_not_found".to_string())?
                .set_text(&new_text)
                .map_err(|error| error.to_string())?;
            if !bindings.is_true(unsafe {
                bindings.FPDFText_SetPositions(handle, positions.as_ptr(), positions.len())
            }) {
                return Err("positioned_set_positions".to_string());
            }
            positioned = true;
            break;
        }
        if !positioned {
            return Err("positioned_text_object_not_found".to_string());
        }
        final_page
            .regenerate_content()
            .map_err(|error| error.to_string())?;
        drop(final_page);
        let final_bytes = final_document
            .save_to_bytes()
            .map_err(|error| error.to_string())?;

        {
            let verification_document = pdfium
                .load_pdf_from_byte_slice(&final_bytes, None)
                .map_err(|error| error.to_string())?;
            let verification_page = verification_document
                .pages()
                .get(page_index)
                .map_err(|error| error.to_string())?;
            if page_text_without_whitespace(&verification_page)? != expected_page {
                return Err("positioned_page_divergence".to_string());
            }
            let verification_text = verification_page
                .text()
                .map_err(|error| error.to_string())?;
            let verification_object = verification_page
                .objects()
                .iter()
                .nth(object_index)
                .ok_or_else(|| "positioned_text_object_not_found".to_string())?;
            let verification_text_object = verification_object
                .as_text_object()
                .ok_or_else(|| "positioned_text_object_not_found".to_string())?;
            if strip_whitespace(&verification_text.for_object(verification_text_object))
                != expected_object
            {
                return Err("positioned_object_divergence".to_string());
            }
            let verification_chars = verification_text
                .chars_for_object(verification_text_object)
                .map_err(|error| error.to_string())?;
            if verification_chars.len() != desired.len() {
                return Err("positioned_origin_count".to_string());
            }
            for (character, expected) in verification_chars.iter().zip(desired.iter()) {
                let (x, y) = character
                    .origin()
                    .map_err(|_| "positioned_char_origin".to_string())?;
                if (x.value as f64 - expected.x).abs() > POSITION_TOLERANCE_PT
                    || (y.value as f64 - expected.y).abs() > POSITION_TOLERANCE_PT
                {
                    return Err("positioned_layout_divergence".to_string());
                }
            }
        }
        final_bytes
    };

    // Repli rare : une image pleine page est volontairement renvoyée comme
    // bande. Le frontend utilise déjà strip_top/strip_height pour la placer.
    let rendered = render_pdf_page_png(&output_bytes, page_number, scale)?;
    let analysis = analyze_pdf_page(&output_bytes, page_number)?;
    Ok(NativeTextEditOutcome {
        bytes: output_bytes,
        report: NativeTextEditReport {
            strip_png_base64: rendered.png_base64,
            strip_top_px: 0,
            strip_height_px: rendered.height_px,
            image_width_px: rendered.width_px,
            image_height_px: rendered.height_px,
            glyphs_ok: true,
            analysis,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desired_origins_preserve_prefix_and_suffix_kerning() {
        let old = vec![
            Point { x: 10.0, y: 20.0 },
            Point { x: 15.0, y: 20.0 },
            Point { x: 21.0, y: 20.0 },
            Point { x: 26.5, y: 20.0 },
        ];
        let temporary = vec![
            Point { x: 10.0, y: 20.0 },
            Point { x: 16.0, y: 20.0 },
            Point { x: 22.0, y: 20.0 },
            Point { x: 28.0, y: 20.0 },
            Point { x: 34.0, y: 20.0 },
        ];
        let sources = vec![
            CharSource::Retained {
                old_ordinal: 0,
                suffix: false,
            },
            CharSource::Retained {
                old_ordinal: 1,
                suffix: false,
            },
            CharSource::Inserted,
            CharSource::Retained {
                old_ordinal: 2,
                suffix: true,
            },
            CharSource::Retained {
                old_ordinal: 3,
                suffix: true,
            },
        ];

        let desired = desired_origins(&old, &temporary, &sources).expect("positions");
        assert_eq!(desired[0].x, 10.0);
        assert_eq!(desired[1].x, 15.0);
        assert_eq!(desired[2].x, 21.0);
        assert_eq!(desired[3].x, 27.0);
        assert_eq!(desired[4].x - desired[3].x, 5.5);
    }

    #[test]
    fn desired_origins_close_gap_after_deletion() {
        let old = vec![
            Point { x: 10.0, y: 20.0 },
            Point { x: 15.0, y: 20.0 },
            Point { x: 21.0, y: 20.0 },
        ];
        let temporary = vec![Point { x: 10.0, y: 20.0 }, Point { x: 16.0, y: 20.0 }];
        let sources = vec![
            CharSource::Retained {
                old_ordinal: 0,
                suffix: false,
            },
            CharSource::Retained {
                old_ordinal: 2,
                suffix: true,
            },
        ];

        let desired = desired_origins(&old, &temporary, &sources).expect("positions");
        assert_eq!(desired[0].x, 10.0);
        assert_eq!(desired[1].x, 16.0);
    }
}
