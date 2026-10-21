//! Sous-ensemble des polices embarquées lors des éditions (comportement
//! Acrobat/Word) : au lieu d'embarquer un fichier TrueType complet (Arial ≈ 1 Mo,
//! Liberation ≈ 350 Ko) à chaque texte ajouté, on n'embarque que les glyphes
//! utilisés + le répertoire Latin-1 (WinAnsi) — pour qu'une édition ultérieure
//! du même texte reste dans la même police.
//!
//! Le subsetter (fontcull/klippa, portage Rust de hb-subset) CONSERVE la table
//! `cmap` : la police reste un TrueType autonome valide, exploitable par PDFium
//! (`FPDFText_LoadFont`) comme par une police simple /WinAnsiEncoding.

use std::collections::{BTreeSet, HashMap};

use lopdf::{Document, Object, ObjectId};

/// Répertoire de base toujours conservé : tout WinAnsi imprimable (32..=255).
fn base_repertoire() -> BTreeSet<u32> {
    (0x20u32..=0xFF)
        .filter_map(|code| crate::pdf_fallback_font::winansi_char(code as u8))
        .map(|ch| ch as u32)
        .collect()
}

/// Sous-ensemble `data` (TrueType/OpenType autonome) aux caractères de `text`
/// plus le répertoire Latin-1. Erreur si le fichier n'est pas exploitable par
/// le subsetter (collection `ttcf` non extraite, format inconnu…).
pub fn subset_font(data: &[u8], text: &str) -> Result<Vec<u8>, String> {
    if data.starts_with(b"ttcf") {
        return Err("font_collection_not_extracted".to_string());
    }
    let mut unicodes = base_repertoire();
    unicodes.extend(
        text.chars()
            .filter(|ch| !ch.is_control())
            .map(|ch| ch as u32),
    );
    let unicodes: Vec<u32> = unicodes.into_iter().collect();
    let subset = fontcull::subset_font_data_unicode(data, &unicodes, &[])
        .map_err(|e| format!("font subset: {e}"))?;
    if subset.len() < 12 || subset.len() >= data.len() {
        // Un sous-ensemble plus gros que l'original n'apporte rien : garder la
        // police telle quelle plutôt qu'un fichier réécrit pour rien.
        return Ok(data.to_vec());
    }
    Ok(subset)
}

/// Extrait la face `index` d'une collection TrueType (`.ttc`) en fichier
/// autonome. Retourne `None` si `data` n'est pas une collection ou si l'index
/// est hors limites / le fichier tronqué.
pub fn extract_collection_face(data: &[u8], index: u32) -> Option<Vec<u8>> {
    if !data.starts_with(b"ttcf") || data.len() < 12 {
        return None;
    }
    let read_u32 = |at: usize| -> Option<u32> {
        data.get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let read_u16 = |at: usize| -> Option<u16> {
        data.get(at..at + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
    };
    let num_fonts = read_u32(8)?;
    if index >= num_fonts {
        return None;
    }
    let face_offset = read_u32(12 + index as usize * 4)? as usize;
    let sfnt_version = read_u32(face_offset)?;
    let num_tables = read_u16(face_offset + 4)? as usize;
    let records_start = face_offset + 12;

    // En-tête + répertoire des tables (offsets recalculés), puis les tables
    // alignées sur 4 octets comme l'exige le format sfnt.
    let mut out = Vec::new();
    out.extend_from_slice(&sfnt_version.to_be_bytes());
    out.extend_from_slice(&data[face_offset + 4..face_offset + 12]);
    let mut table_data: Vec<(usize, usize)> = Vec::with_capacity(num_tables);
    let mut next_offset = 12 + num_tables * 16;
    for i in 0..num_tables {
        let record = records_start + i * 16;
        let tag = data.get(record..record + 4)?;
        let checksum = data.get(record + 4..record + 8)?;
        let offset = read_u32(record + 8)? as usize;
        let length = read_u32(record + 12)? as usize;
        data.get(offset..offset + length)?;
        out.extend_from_slice(tag);
        out.extend_from_slice(checksum);
        out.extend_from_slice(&(next_offset as u32).to_be_bytes());
        out.extend_from_slice(&(length as u32).to_be_bytes());
        table_data.push((offset, length));
        next_offset += (length + 3) & !3;
    }
    for (offset, length) in table_data {
        out.extend_from_slice(&data[offset..offset + length]);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    Some(out)
}

/// Dédoublonne les programmes de police identiques (/FontFile, /FontFile2,
/// /FontFile3) : chaque passe d'ajout de texte via PDFium recrée un objet police
/// complet, même quand la police est la même. Les descripteurs sont repointés
/// vers un exemplaire unique et les copies supprimées.
pub fn dedupe_font_programs(doc: &mut Document) -> usize {
    const KEYS: [&[u8]; 3] = [b"FontFile", b"FontFile2", b"FontFile3"];
    // (id descripteur, clé, id programme) pour chaque référence de programme.
    let mut references: Vec<(ObjectId, &'static [u8], ObjectId)> = Vec::new();
    for (&id, object) in doc.objects.iter() {
        let Object::Dictionary(dict) = object else {
            continue;
        };
        if dict.get(b"Type").and_then(Object::as_name).ok() != Some(b"FontDescriptor") {
            continue;
        }
        for key in KEYS {
            if let Ok(Object::Reference(program)) = dict.get(key) {
                references.push((id, key, *program));
            }
        }
    }
    // Contenu identique → premier id rencontré (ordre croissant des ids).
    let mut canonical: HashMap<(Vec<u8>, Vec<u8>), ObjectId> = HashMap::new();
    let mut replace: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut program_ids: Vec<ObjectId> = references.iter().map(|(_, _, p)| *p).collect();
    program_ids.sort();
    program_ids.dedup();
    for program in program_ids {
        let Ok(stream) = doc.get_object(program).and_then(Object::as_stream) else {
            continue;
        };
        let subtype = stream
            .dict
            .get(b"Subtype")
            .and_then(Object::as_name)
            .map(|n| n.to_vec())
            .unwrap_or_default();
        let key = (subtype, stream.content.clone());
        match canonical.get(&key) {
            Some(&keep) if keep != program => {
                replace.insert(program, keep);
            }
            Some(_) => {}
            None => {
                canonical.insert(key, program);
            }
        }
    }
    if replace.is_empty() {
        return 0;
    }
    for (descriptor, key, program) in references {
        let Some(&keep) = replace.get(&program) else {
            continue;
        };
        if let Ok(dict) = doc.get_dictionary_mut(descriptor) {
            dict.set(key, Object::Reference(keep));
        }
    }
    for duplicate in replace.keys() {
        doc.objects.remove(duplicate);
    }
    replace.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SANS: &[u8] = include_bytes!("../assets/fonts/LiberationSans-Regular.ttf");

    #[test]
    fn subset_keeps_cmap_and_shrinks() {
        let subset = subset_font(SANS, "Facture n° 42 — été").expect("subset");
        assert!(
            subset.len() * 4 < SANS.len(),
            "{} vs {}",
            subset.len(),
            SANS.len()
        );
        let face = ttf_parser::Face::parse(&subset, 0).expect("subset parse");
        for ch in "Facture n° 42 — été €œÀ".chars() {
            assert!(face.glyph_index(ch).is_some(), "glyphe manquant : {ch:?}");
        }
        // Hors répertoire : absent du sous-ensemble.
        assert!(face.glyph_index('Ω').is_none());
        // Métriques conservées.
        let full = ttf_parser::Face::parse(SANS, 0).unwrap();
        let (a, b) = (
            full.glyph_index('F').unwrap(),
            face.glyph_index('F').unwrap(),
        );
        assert_eq!(full.glyph_hor_advance(a), face.glyph_hor_advance(b));
    }

    #[test]
    fn collection_face_extraction_round_trip() {
        // Collection synthétique : deux fois la même face.
        let face_a = SANS;
        let mut ttc = Vec::new();
        ttc.extend_from_slice(b"ttcf");
        ttc.extend_from_slice(&[0, 1, 0, 0]);
        ttc.extend_from_slice(&2u32.to_be_bytes());
        let header_len = 12 + 2 * 4;
        // Les deux faces partagent la même table de répertoire recopiée à la
        // suite de l'en-tête ; les offsets de tables sont ajustés d'autant.
        let shift = header_len as u32;
        let num_tables = u16::from_be_bytes([face_a[4], face_a[5]]) as usize;
        let mut directory = face_a[..12 + num_tables * 16].to_vec();
        for i in 0..num_tables {
            let at = 12 + i * 16 + 8;
            let offset = u32::from_be_bytes([
                directory[at],
                directory[at + 1],
                directory[at + 2],
                directory[at + 3],
            ]);
            directory[at..at + 4].copy_from_slice(&(offset + shift).to_be_bytes());
        }
        ttc.extend_from_slice(&shift.to_be_bytes());
        ttc.extend_from_slice(&shift.to_be_bytes());
        ttc.extend_from_slice(&directory);
        ttc.extend_from_slice(&face_a[12 + num_tables * 16..]);

        let extracted = extract_collection_face(&ttc, 1).expect("face 1");
        let face = ttf_parser::Face::parse(&extracted, 0).expect("face autonome");
        assert!(face.glyph_index('A').is_some());
        assert!(extract_collection_face(&ttc, 2).is_none());
        assert!(extract_collection_face(SANS, 0).is_none());
        // Et le sous-ensemble de la face extraite fonctionne.
        assert!(subset_font(&extracted, "abc").is_ok());
        assert!(subset_font(&ttc, "abc").is_err());
    }

    #[test]
    fn dedupe_merges_identical_font_programs() {
        use lopdf::{dictionary, Stream};
        let mut doc = Document::with_version("1.7");
        let program = |doc: &mut Document, bytes: &[u8]| {
            doc.add_object(Stream::new(dictionary! {}, bytes.to_vec()))
        };
        let p1 = program(&mut doc, b"FONT-A");
        let p2 = program(&mut doc, b"FONT-A");
        let p3 = program(&mut doc, b"FONT-B");
        for p in [p1, p2, p3] {
            doc.add_object(dictionary! {
                "Type" => Object::Name(b"FontDescriptor".to_vec()),
                "FontFile2" => Object::Reference(p),
            });
        }
        assert_eq!(dedupe_font_programs(&mut doc), 1);
        assert!(doc.get_object(p2).is_err());
        assert!(doc.get_object(p1).is_ok() && doc.get_object(p3).is_ok());
        let pointing_to_p1 = doc
            .objects
            .values()
            .filter(|o| matches!(o, Object::Dictionary(d) if d.get(b"FontFile2").ok() == Some(&Object::Reference(p1))))
            .count();
        assert_eq!(pointing_to_p1, 2);
    }
}
