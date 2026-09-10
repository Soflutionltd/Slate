//! Police de secours embarquée (comportement Adobe) : quand un caractère
//! inséré n'existe pas dans la police d'origine du PDF (sous-ensemble sans le
//! glyphe, encodage restreint), on écrit le caractère avec une police
//! Liberation embarquée dans le document — au lieu de refuser l'édition et de
//! basculer le bloc en rendu HTML.
//!
//! Les polices Liberation sont métriquement compatibles avec Arial/Helvetica
//! (Sans), Times New Roman (Serif) et Courier New (Mono) — licence SIL OFL
//! (voir assets/fonts/LICENSE-Liberation.txt).

use lopdf::{dictionary, Document, Object, ObjectId, Stream};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackStyle {
    Sans,
    SansBold,
    SansItalic,
    Serif,
    SerifBold,
    Mono,
}

impl FallbackStyle {
    fn font_bytes(self) -> &'static [u8] {
        match self {
            FallbackStyle::Sans => {
                include_bytes!("../assets/fonts/LiberationSans-Regular.ttf")
            }
            FallbackStyle::SansBold => include_bytes!("../assets/fonts/LiberationSans-Bold.ttf"),
            FallbackStyle::SansItalic => {
                include_bytes!("../assets/fonts/LiberationSans-Italic.ttf")
            }
            FallbackStyle::Serif => {
                include_bytes!("../assets/fonts/LiberationSerif-Regular.ttf")
            }
            FallbackStyle::SerifBold => include_bytes!("../assets/fonts/LiberationSerif-Bold.ttf"),
            FallbackStyle::Mono => include_bytes!("../assets/fonts/LiberationMono-Regular.ttf"),
        }
    }

    /// Nom PostScript utilisé comme /BaseFont — sert aussi de marqueur pour
    /// retrouver une police déjà embarquée dans le document.
    fn base_font_name(self) -> &'static str {
        match self {
            FallbackStyle::Sans => "AltoFB-LiberationSans",
            FallbackStyle::SansBold => "AltoFB-LiberationSans-Bold",
            FallbackStyle::SansItalic => "AltoFB-LiberationSans-Italic",
            FallbackStyle::Serif => "AltoFB-LiberationSerif",
            FallbackStyle::SerifBold => "AltoFB-LiberationSerif-Bold",
            FallbackStyle::Mono => "AltoFB-LiberationMono",
        }
    }

    fn flags(self) -> i64 {
        // Bit 1 = FixedPitch, bit 2 = Serif, bit 6 = Nonsymbolic, bit 7 = Italic.
        let mut flags = 1 << 5; // Nonsymbolic (indispensable pour WinAnsi)
        if matches!(self, FallbackStyle::Serif | FallbackStyle::SerifBold) {
            flags |= 1 << 1;
        }
        if matches!(self, FallbackStyle::SansItalic) {
            flags |= 1 << 6;
        }
        if matches!(self, FallbackStyle::Mono) {
            flags |= 1 << 0;
        }
        flags
    }

    fn stem_v(self) -> i64 {
        match self {
            FallbackStyle::SansBold | FallbackStyle::SerifBold => 160,
            _ => 84,
        }
    }
}

/// Choisit le style de secours le plus proche de la police d'origine, à partir
/// de son nom (famille PDFium ou /BaseFont).
pub fn style_for_font_name(name: &str) -> FallbackStyle {
    let lower = name.to_lowercase();
    let bold = lower.contains("bold")
        || lower.contains("black")
        || lower.contains("heavy")
        || lower.ends_with("-bd");
    let italic = lower.contains("italic") || lower.contains("oblique");
    let mono = lower.contains("mono") || lower.contains("courier") || lower.contains("consol");
    let serif = !mono
        && (lower.contains("times")
            || lower.contains("georgia")
            || lower.contains("garamond")
            || lower.contains("book")
            || lower.contains("cambria")
            || lower.contains("palatino")
            || (lower.contains("serif") && !lower.contains("sans")));
    if mono {
        FallbackStyle::Mono
    } else if serif {
        if bold {
            FallbackStyle::SerifBold
        } else {
            FallbackStyle::Serif
        }
    } else if bold {
        FallbackStyle::SansBold
    } else if italic {
        FallbackStyle::SansItalic
    } else {
        FallbackStyle::Sans
    }
}

/// Table WinAnsiEncoding (cp1252) : code → unicode. Codes < 32 non mappés.
fn winansi_to_unicode(code: u8) -> Option<char> {
    match code {
        0x00..=0x1F => None,
        // Plage 0x80–0x9F : caractères spécifiques cp1252.
        0x80 => Some('\u{20AC}'), // €
        0x82 => Some('\u{201A}'),
        0x83 => Some('\u{0192}'),
        0x84 => Some('\u{201E}'),
        0x85 => Some('\u{2026}'),
        0x86 => Some('\u{2020}'),
        0x87 => Some('\u{2021}'),
        0x88 => Some('\u{02C6}'),
        0x89 => Some('\u{2030}'),
        0x8A => Some('\u{0160}'),
        0x8B => Some('\u{2039}'),
        0x8C => Some('\u{0152}'),
        0x8E => Some('\u{017D}'),
        0x91 => Some('\u{2018}'),
        0x92 => Some('\u{2019}'),
        0x93 => Some('\u{201C}'),
        0x94 => Some('\u{201D}'),
        0x95 => Some('\u{2022}'),
        0x96 => Some('\u{2013}'),
        0x97 => Some('\u{2014}'),
        0x98 => Some('\u{02DC}'),
        0x99 => Some('\u{2122}'),
        0x9A => Some('\u{0161}'),
        0x9B => Some('\u{203A}'),
        0x9C => Some('\u{0153}'),
        0x9E => Some('\u{017E}'),
        0x9F => Some('\u{0178}'),
        0x81 | 0x8D | 0x8F | 0x90 | 0x9D => None,
        // Le reste coïncide avec Latin-1.
        _ => char::from_u32(code as u32),
    }
}

/// Encode un texte en octets WinAnsi. None si un caractère n'a pas de code.
pub fn winansi_encode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let code = (0x20u8..=0xFF)
            .find(|&code| winansi_to_unicode(code) == Some(ch))?;
        out.push(code);
    }
    Some(out)
}

/// Vrai si tous les caractères de `text` sont encodables en WinAnsi ET ont un
/// glyphe dans la police de secours.
pub fn can_render(style: FallbackStyle, text: &str) -> bool {
    let Ok(face) = ttf_parser::Face::parse(style.font_bytes(), 0) else {
        return false;
    };
    text.chars().all(|ch| {
        !ch.is_control()
            && winansi_encode(&ch.to_string()).is_some()
            && (ch == ' ' || face.glyph_index(ch).is_some())
    })
}

/// Garantit que la police de secours est embarquée dans le document ET
/// enregistrée dans les ressources de la page. Retourne le NOM DE RESSOURCE
/// (opérande de Tf) à utiliser dans le flux de contenu.
pub fn ensure_page_fallback_font(
    doc: &mut Document,
    page_id: ObjectId,
    style: FallbackStyle,
) -> Result<Vec<u8>, String> {
    let font_id = find_embedded_font(doc, style)
        .map_or_else(|| embed_font(doc, style), Ok)?;

    // 1) Lire l'entrée /Font des ressources (get_or_create_resources résout
    //    lui-même les ressources référencées ou inline). Portée dédiée : le
    //    résultat emprunte `doc` mutablement.
    let font_entry: Option<Object> = {
        let resources = doc
            .get_or_create_resources(page_id)
            .map_err(|e| format!("lopdf resources: {e}"))?;
        let dict = resources
            .as_dict()
            .map_err(|e| format!("resources dict: {e}"))?;
        dict.get(b"Font").ok().cloned()
    };
    let fonts_snapshot: Option<lopdf::Dictionary> = match &font_entry {
        Some(Object::Dictionary(d)) => Some(d.clone()),
        Some(Object::Reference(id)) => doc.get_dictionary(*id).ok().cloned(),
        _ => None,
    };

    // Déjà enregistrée sur cette page ? Réutiliser le nom existant.
    if let Some(fonts) = &fonts_snapshot {
        for (name, value) in fonts.iter() {
            if matches!(value, Object::Reference(id) if *id == font_id) {
                return Ok(name.clone());
            }
        }
    }

    // Nom de ressource libre (AltoFB0, AltoFB1, …).
    let existing: Vec<Vec<u8>> = fonts_snapshot
        .as_ref()
        .map(|d| d.iter().map(|(n, _)| n.clone()).collect())
        .unwrap_or_default();
    let mut n = 0usize;
    let name = loop {
        let candidate = format!("AltoFB{n}").into_bytes();
        if !existing.contains(&candidate) {
            break candidate;
        }
        n += 1;
    };

    // 2) Écrire l'entrée. Dictionnaire /Font référencé : écrire dans l'objet
    //    cible ; inline ou absent : écrire dans les ressources directement.
    if let Some(Object::Reference(id)) = font_entry {
        let fonts = doc
            .get_dictionary_mut(id)
            .map_err(|e| format!("fonts dict: {e}"))?;
        fonts.set(name.clone(), Object::Reference(font_id));
    } else {
        let resources = doc
            .get_or_create_resources(page_id)
            .map_err(|e| format!("lopdf resources: {e}"))?;
        let dict = resources
            .as_dict_mut()
            .map_err(|e| format!("resources mut: {e}"))?;
        if !dict.has(b"Font") {
            dict.set(b"Font", lopdf::Dictionary::new());
        }
        match dict.get_mut(b"Font").map_err(|e| format!("font entry: {e}"))? {
            Object::Dictionary(d) => d.set(name.clone(), Object::Reference(font_id)),
            _ => return Err("font_dict_shape".to_string()),
        }
    }
    Ok(name)
}

/// Cherche une police de secours déjà embarquée (marqueur /BaseFont).
fn find_embedded_font(doc: &Document, style: FallbackStyle) -> Option<ObjectId> {
    let marker = style.base_font_name().as_bytes();
    for (&id, object) in doc.objects.iter() {
        let Object::Dictionary(dict) = object else { continue };
        if dict.get(b"Type").and_then(Object::as_name).ok() != Some(b"Font") {
            continue;
        }
        if dict.get(b"BaseFont").and_then(Object::as_name).ok() == Some(marker) {
            return Some(id);
        }
    }
    None
}

/// Embarque la police TrueType complète : FontFile2 + FontDescriptor + Font
/// (/TrueType, WinAnsiEncoding, Widths 32..255).
fn embed_font(doc: &mut Document, style: FallbackStyle) -> Result<ObjectId, String> {
    let data = style.font_bytes();
    let face = ttf_parser::Face::parse(data, 0).map_err(|e| format!("ttf: {e}"))?;
    let upem = face.units_per_em() as f64;
    let to_pdf = |v: f64| (v * 1000.0 / upem).round() as i64;

    let widths: Vec<Object> = (32u8..=255)
        .map(|code| {
            let width = winansi_to_unicode(code)
                .and_then(|ch| face.glyph_index(ch))
                .and_then(|gid| face.glyph_hor_advance(gid))
                .map(|adv| to_pdf(adv as f64))
                .unwrap_or(0);
            Object::Integer(width)
        })
        .collect();

    let bbox = face.global_bounding_box();
    let file_id = doc.add_object(Stream::new(
        dictionary! { "Length1" => Object::Integer(data.len() as i64) },
        data.to_vec(),
    ));
    let descriptor_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"FontDescriptor".to_vec()),
        "FontName" => Object::Name(style.base_font_name().as_bytes().to_vec()),
        "Flags" => Object::Integer(style.flags()),
        "FontBBox" => Object::Array(vec![
            Object::Integer(to_pdf(bbox.x_min as f64)),
            Object::Integer(to_pdf(bbox.y_min as f64)),
            Object::Integer(to_pdf(bbox.x_max as f64)),
            Object::Integer(to_pdf(bbox.y_max as f64)),
        ]),
        "ItalicAngle" => Object::Integer(if style == FallbackStyle::SansItalic { -12 } else { 0 }),
        "Ascent" => Object::Integer(to_pdf(face.ascender() as f64)),
        "Descent" => Object::Integer(to_pdf(face.descender() as f64)),
        "CapHeight" => Object::Integer(
            face.capital_height().map(|c| to_pdf(c as f64)).unwrap_or(700),
        ),
        "StemV" => Object::Integer(style.stem_v()),
        "FontFile2" => Object::Reference(file_id),
    });
    Ok(doc.add_object(dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"TrueType".to_vec()),
        "BaseFont" => Object::Name(style.base_font_name().as_bytes().to_vec()),
        "FirstChar" => Object::Integer(32),
        "LastChar" => Object::Integer(255),
        "Widths" => Object::Array(widths),
        "Encoding" => Object::Name(b"WinAnsiEncoding".to_vec()),
        "FontDescriptor" => Object::Reference(descriptor_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winansi_round_trip_latin() {
        for text in ["Bonjour", "élévation à 3 €", "œuvre — “quotes”"] {
            let bytes = winansi_encode(text).expect("encodable");
            let back: String = bytes
                .iter()
                .map(|&b| winansi_to_unicode(b).unwrap())
                .collect();
            assert_eq!(back, text);
        }
        assert!(winansi_encode("Ω").is_none());
    }

    #[test]
    fn fallback_fonts_parse_and_cover_latin() {
        for style in [
            FallbackStyle::Sans,
            FallbackStyle::SansBold,
            FallbackStyle::SansItalic,
            FallbackStyle::Serif,
            FallbackStyle::SerifBold,
            FallbackStyle::Mono,
        ] {
            assert!(can_render(style, "AzÉрq0129€œ—".replace('р', "").as_str()), "{style:?}");
            assert!(!can_render(style, "Ω"), "{style:?} ne doit pas couvrir le grec");
        }
    }

    #[test]
    fn style_detection_from_names() {
        assert_eq!(style_for_font_name("Helvetica"), FallbackStyle::Sans);
        assert_eq!(style_for_font_name("Arial-BoldMT"), FallbackStyle::SansBold);
        assert_eq!(style_for_font_name("TimesNewRomanPSMT"), FallbackStyle::Serif);
        assert_eq!(style_for_font_name("Times-Bold"), FallbackStyle::SerifBold);
        assert_eq!(style_for_font_name("CourierNewPSMT"), FallbackStyle::Mono);
        assert_eq!(style_for_font_name("Arial-ItalicMT"), FallbackStyle::SansItalic);
    }
}
