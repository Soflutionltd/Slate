//! Compression réelle des PDF : ré-échantillonnage + ré-encodage JPEG des images
//! incrustées, puis compression structurelle (object/xref streams, prune).
//!
//! Conception volontairement prudente : on ne touche qu'aux images dont on est
//! certain de pouvoir reconstruire le flux sans le corrompre, et on ne remplace
//! une image que si le résultat est strictement plus petit. Tout cas ambigu
//! (CMYK, indexé, ICCBased, masque de transparence, JBIG2/JPX/CCITT…) est ignoré.

use std::io::Cursor;

use image::{DynamicImage, ImageBuffer, ImageFormat, Luma, Rgb};
use lopdf::{Document, Object, ObjectId, SaveOptions};
use rayon::prelude::*;

struct Level {
    /// Plus grande dimension tolérée en pixels avant ré-échantillonnage.
    max_dim: u32,
    /// Qualité JPEG (0-100).
    quality: u8,
}

fn level_params(level: &str) -> Level {
    match level {
        "low" | "screen" => Level {
            max_dim: 1000,
            quality: 55,
        },
        "high" | "quality" => Level {
            max_dim: 2400,
            quality: 85,
        },
        // "medium" / équilibré : valeur par défaut.
        _ => Level {
            max_dim: 1600,
            quality: 72,
        },
    }
}

/// Lit un entier depuis le dictionnaire, en résolvant une éventuelle référence.
fn dict_int(doc: &Document, dict: &lopdf::Dictionary, key: &[u8]) -> Option<i64> {
    match dict.get(key).ok()? {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_i64().ok(),
        other => other.as_i64().ok(),
    }
}

/// Renvoie le nombre de composantes (1 = gris, 3 = RVB) pour les espaces
/// colorimétriques sûrs uniquement. `None` => image ignorée.
fn colorspace_components(doc: &Document, dict: &lopdf::Dictionary) -> Option<u8> {
    let obj = dict.get(b"ColorSpace").ok()?;
    let resolved = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    match resolved.as_name().ok()? {
        b"DeviceRGB" | b"RGB" | b"CalRGB" => Some(3),
        b"DeviceGray" | b"G" | b"CalGray" => Some(1),
        _ => None,
    }
}

struct Replacement {
    id: ObjectId,
    jpeg: Vec<u8>,
    width: i64,
    height: i64,
    gray: bool,
}

/// Pixels source d'une image, extraits du PDF, prêts à être décodés en parallèle.
enum Source {
    /// Flux DCTDecode : fichier JPEG complet à décoder.
    Jpeg(Vec<u8>),
    /// Échantillons bruts RVB (3 octets/pixel).
    RawRgb(Vec<u8>),
    /// Échantillons bruts niveaux de gris (1 octet/pixel).
    RawGray(Vec<u8>),
}

struct Candidate {
    id: ObjectId,
    width: u32,
    height: u32,
    gray: bool,
    original_len: usize,
    source: Source,
}

/// Décode, ré-échantillonne et ré-encode un candidat en JPEG. Renvoie un
/// remplacement uniquement si le résultat est strictement plus petit.
/// Fonction pure (aucun accès PDFium/lopdf) → parallélisable sans contention.
fn process_candidate(candidate: &Candidate, params: &Level) -> Option<Replacement> {
    let (w, h) = (candidate.width, candidate.height);
    let source = match &candidate.source {
        Source::Jpeg(bytes) => image::load_from_memory_with_format(bytes, ImageFormat::Jpeg).ok()?,
        Source::RawRgb(raw) => {
            DynamicImage::ImageRgb8(ImageBuffer::<Rgb<u8>, _>::from_raw(w, h, raw.clone())?)
        }
        Source::RawGray(raw) => {
            DynamicImage::ImageLuma8(ImageBuffer::<Luma<u8>, _>::from_raw(w, h, raw.clone())?)
        }
    };

    let max_side = w.max(h);
    let resized = if max_side > params.max_dim {
        let scale = params.max_dim as f32 / max_side as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        source.resize_exact(nw, nh, image::imageops::FilterType::Triangle)
    } else {
        source
    };
    let (nw, nh) = (resized.width(), resized.height());

    let mut jpeg = Vec::new();
    let encoded = {
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, params.quality);
        if candidate.gray {
            encoder.encode_image(&resized.to_luma8())
        } else {
            encoder.encode_image(&resized.to_rgb8())
        }
    };
    encoded.ok()?;

    // On ne remplace que si on gagne réellement de la place.
    if jpeg.len() >= candidate.original_len {
        return None;
    }

    Some(Replacement {
        id: candidate.id,
        jpeg,
        width: nw as i64,
        height: nh as i64,
        gray: candidate.gray,
    })
}

/// Compresse un PDF en ré-échantillonnant/ré-encodant ses images, puis applique
/// une compression structurelle. `level` ∈ {"low","medium","high"}.
pub fn compress_pdf_images(bytes: Vec<u8>, level: &str) -> Result<Vec<u8>, String> {
    let params = level_params(level);
    let mut doc = Document::load_mem(&bytes).map_err(|e| e.to_string())?;

    // 1) Collecte série (lecture lopdf + décompression sans perte). On ne fait
    //    ici que le travail qui exige `&doc` ; le décodage/ré-encodage suit.
    let mut candidates: Vec<Candidate> = Vec::new();
    for (id, obj) in &doc.objects {
        let Object::Stream(stream) = obj else {
            continue;
        };
        let dict = &stream.dict;

        // Doit être une image XObject.
        let is_image = dict
            .get(b"Subtype")
            .ok()
            .and_then(|o| o.as_name().ok())
            == Some(&b"Image"[..]);
        if !is_image {
            continue;
        }

        // Masques / transparence / valeurs non gérées : on s'abstient.
        if matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true))) {
            continue;
        }
        if dict.has(b"SMask") || dict.has(b"Mask") || dict.has(b"Decode") {
            continue;
        }
        if dict_int(&doc, dict, b"BitsPerComponent") != Some(8) {
            continue;
        }
        let Some(components) = colorspace_components(&doc, dict) else {
            continue;
        };
        let gray = components == 1;

        let (Some(w), Some(h)) = (
            dict_int(&doc, dict, b"Width"),
            dict_int(&doc, dict, b"Height"),
        ) else {
            continue;
        };
        if w <= 0 || h <= 0 || w > 20_000 || h > 20_000 {
            continue;
        }
        let (w, h) = (w as u32, h as u32);

        let filters: Vec<Vec<u8>> = stream
            .filters()
            .map(|v| v.into_iter().map(<[u8]>::to_vec).collect())
            .unwrap_or_default();

        let original_len = stream.content.len();

        let source = if filters.len() == 1 && filters[0] == b"DCTDecode" {
            // Le flux est déjà un fichier JPEG complet.
            Source::Jpeg(stream.content.clone())
        } else if filters
            .iter()
            .all(|f| matches!(f.as_slice(), b"FlateDecode" | b"LZWDecode" | b"ASCII85Decode"))
        {
            // Échantillons bruts (éventuellement compressés sans perte).
            let raw = if filters.is_empty() {
                stream.content.clone()
            } else {
                match stream.decompressed_content() {
                    Ok(r) => r,
                    Err(_) => continue,
                }
            };
            let expected = (w as usize) * (h as usize) * (components as usize);
            if raw.len() < expected {
                continue;
            }
            let raw = raw[..expected].to_vec();
            if gray {
                Source::RawGray(raw)
            } else {
                Source::RawRgb(raw)
            }
        } else {
            // JBIG2 / JPX / CCITT / RunLength / filtres combinés : ignorés.
            continue;
        };

        candidates.push(Candidate {
            id: *id,
            width: w,
            height: h,
            gray,
            original_len,
            source,
        });
    }

    // 2) Traitement parallèle (décodage + redimension + ré-encodage), CPU-bound
    //    et indépendant par image.
    let replacements: Vec<Replacement> = candidates
        .par_iter()
        .filter_map(|candidate| process_candidate(candidate, &params))
        .collect();

    // 3) Application série des remplacements (mutation lopdf).
    for rep in replacements {
        if let Ok(stream) = doc
            .get_object_mut(rep.id)
            .and_then(|o| o.as_stream_mut())
        {
            stream.dict.remove(b"DecodeParms");
            stream.dict.remove(b"DecodeParams");
            stream.dict.remove(b"Filter");
            stream.set_content(rep.jpeg);
            stream.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            stream.dict.set("Width", rep.width);
            stream.dict.set("Height", rep.height);
            stream.dict.set("BitsPerComponent", 8i64);
            stream.dict.set(
                "ColorSpace",
                Object::Name(if rep.gray {
                    b"DeviceGray".to_vec()
                } else {
                    b"DeviceRGB".to_vec()
                }),
            );
            // Empêche la passe structurelle de re-zipper un JPEG déjà compact.
            stream.allows_compression = false;
        }
    }

    let _ = doc.delete_zero_length_streams();
    let _ = doc.prune_objects();
    doc.compress();

    let mut out = Vec::new();
    let options = SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .compression_level(9)
        .build();
    doc.save_with_options(&mut Cursor::new(&mut out), options)
        .map_err(|e| e.to_string())?;
    Ok(out)
}
