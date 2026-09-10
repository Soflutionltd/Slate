//! Remplissage de formulaires AcroForm via PDFium.
//!
//! PDFium sait écrire la valeur (`/V`) des champs texte/cases/radios, mais ne
//! régénère pas l'apparence visible. On active donc `NeedAppearances` en
//! post-passe (lopdf) pour que la saisie s'affiche dans tous les lecteurs.
//! Les listes déroulantes / listes (combo/list) sont exposées en lecture seule
//! (pdfium-render 0.9.1 n'offre pas de setter pour ces types).

use std::collections::HashMap;

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use pdfium_render::prelude::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub name: String,
    /// "text" | "checkbox" | "radio" | "combo" | "listbox"
    pub kind: String,
    pub value: Option<String>,
    /// Page 1-indexée où le champ apparaît.
    pub page: usize,
    /// Valeurs possibles (radios : valeurs d'export de chaque bouton du groupe).
    pub options: Vec<String>,
    /// `true` si le type n'est pas modifiable par cet outil (combo/list).
    pub read_only: bool,
}

fn field_kind(field_type: PdfFormFieldType) -> Option<&'static str> {
    match field_type {
        PdfFormFieldType::Text => Some("text"),
        PdfFormFieldType::Checkbox => Some("checkbox"),
        PdfFormFieldType::RadioButton => Some("radio"),
        PdfFormFieldType::ComboBox => Some("combo"),
        PdfFormFieldType::ListBox => Some("listbox"),
        _ => None,
    }
}

/// Énumère les champs de formulaire d'un PDF. Renvoie une liste vide si le
/// document ne contient pas d'AcroForm.
pub fn list_form_fields(bytes: &[u8]) -> Result<Vec<FormField>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    let guard = crate::pdf_engine::pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;

    if document.form().is_none() {
        return Ok(Vec::new());
    }

    let mut fields: Vec<FormField> = Vec::new();
    // name -> index dans `fields`, pour regrouper les boutons radio d'un même groupe.
    let mut radio_index: HashMap<String, usize> = HashMap::new();

    for (page_index, page) in document.pages().iter().enumerate() {
        for annotation in page.annotations().iter() {
            let Some(field) = annotation.as_form_field() else {
                continue;
            };
            let Some(kind) = field_kind(field.field_type()) else {
                continue;
            };
            let name = field.name().unwrap_or_default();
            if name.is_empty() {
                continue;
            }

            if kind == "radio" {
                let on_value = field.as_radio_button_field().and_then(|f| f.group_value());
                let checked = field
                    .as_radio_button_field()
                    .and_then(|f| f.is_checked().ok())
                    .unwrap_or(false);
                if let Some(&idx) = radio_index.get(&name) {
                    // Contrôle additionnel du même groupe : on enrichit options/valeur.
                    if let Some(value) = on_value.clone() {
                        if !fields[idx].options.contains(&value) {
                            fields[idx].options.push(value);
                        }
                    }
                    if checked {
                        fields[idx].value = on_value;
                    }
                    continue;
                }
                radio_index.insert(name.clone(), fields.len());
                fields.push(FormField {
                    name,
                    kind: "radio".to_string(),
                    value: if checked { on_value.clone() } else { None },
                    page: page_index + 1,
                    options: on_value.into_iter().collect(),
                    read_only: false,
                });
                continue;
            }

            let (value, read_only) = match field.field_type() {
                PdfFormFieldType::Text => {
                    (field.as_text_field().and_then(|f| f.value()), false)
                }
                PdfFormFieldType::Checkbox => (
                    Some(
                        field
                            .as_checkbox_field()
                            .and_then(|f| f.is_checked().ok())
                            .unwrap_or(false)
                            .to_string(),
                    ),
                    false,
                ),
                PdfFormFieldType::ComboBox => {
                    (field.as_combo_box_field().and_then(|f| f.value()), true)
                }
                PdfFormFieldType::ListBox => {
                    (field.as_list_box_field().and_then(|f| f.value()), true)
                }
                _ => (None, true),
            };

            fields.push(FormField {
                name,
                kind: kind.to_string(),
                value,
                page: page_index + 1,
                options: Vec::new(),
                read_only,
            });
        }
    }

    Ok(fields)
}

/// Remplit les champs texte/cases/radios avec les valeurs fournies (clé = nom du
/// champ). Renvoie le PDF modifié, avec `NeedAppearances` activé pour que la
/// saisie soit rendue par n'importe quel lecteur.
pub fn fill_form_fields(bytes: &[u8], values: HashMap<String, String>) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    if values.is_empty() {
        return Ok(bytes.to_vec());
    }

    let filled = {
        let guard = crate::pdf_engine::pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        if document.form().is_none() {
            return Err("This PDF has no fillable form.".to_string());
        }

        let page_count = document.pages().len();
        for page_idx in 0..page_count {
            let page = document
                .pages()
                .get(page_idx)
                .map_err(|e| e.to_string())?;
            let annot_count = page.annotations().len();
            for annot_idx in 0..annot_count {
                let mut annotation = match page.annotations().get(annot_idx) {
                    Ok(annotation) => annotation,
                    Err(_) => continue,
                };

                let (name, field_type) = {
                    let Some(field) = annotation.as_form_field() else {
                        continue;
                    };
                    (field.name().unwrap_or_default(), field.field_type())
                };
                let Some(new_value) = values.get(&name) else {
                    continue;
                };

                let Some(field) = annotation.as_form_field_mut() else {
                    continue;
                };
                match field_type {
                    PdfFormFieldType::Text => {
                        if let Some(text) = field.as_text_field_mut() {
                            text.set_value(new_value).map_err(|e| e.to_string())?;
                        }
                    }
                    PdfFormFieldType::Checkbox => {
                        if let Some(checkbox) = field.as_checkbox_field_mut() {
                            let on = matches!(
                                new_value.to_ascii_lowercase().as_str(),
                                "true" | "on" | "yes" | "1" | "checked"
                            );
                            checkbox.set_checked(on).map_err(|e| e.to_string())?;
                        }
                    }
                    PdfFormFieldType::RadioButton => {
                        if let Some(radio) = field.as_radio_button_field_mut() {
                            if radio.group_value().as_deref() == Some(new_value.as_str()) {
                                radio.set_checked().map_err(|e| e.to_string())?;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        document.save_to_bytes().map_err(|e| e.to_string())?
    };

    Ok(set_need_appearances(filled))
}

/// Active `/AcroForm /NeedAppearances true` pour forcer la régénération des
/// apparences par le lecteur (sinon la saisie des champs texte reste invisible).
/// En cas d'échec d'analyse structurelle, renvoie les octets inchangés.
fn set_need_appearances(bytes: Vec<u8>) -> Vec<u8> {
    let result: Result<Vec<u8>, String> = (|| {
        let mut doc = Document::load_mem(&bytes).map_err(|e| e.to_string())?;
        let root_id = doc
            .trailer
            .get(b"Root")
            .map_err(|e| e.to_string())?
            .as_reference()
            .map_err(|e| e.to_string())?;
        let acro = doc
            .get_dictionary(root_id)
            .map_err(|e| e.to_string())?
            .get(b"AcroForm")
            .map_err(|e| e.to_string())?
            .clone();

        match acro {
            Object::Reference(acro_id) => {
                let dict = doc.get_dictionary_mut(acro_id).map_err(|e| e.to_string())?;
                dict.set("NeedAppearances", true);
            }
            Object::Dictionary(mut dict) => {
                dict.set("NeedAppearances", true);
                let root = doc.get_dictionary_mut(root_id).map_err(|e| e.to_string())?;
                root.set("AcroForm", Object::Dictionary(dict));
            }
            _ => return Err("AcroForm not found".to_string()),
        }

        let mut out = Vec::new();
        doc.save_to(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    })();

    result.unwrap_or(bytes)
}

// ---------------------------------------------------------------------------
// Bouton image (« Cliquez pour choisir une photo »)
// ---------------------------------------------------------------------------
//
// Acrobat réalise ça avec un bouton poussoir dont l'action JavaScript appelle
// `event.target.buttonImportIcon()` : le lecteur ouvre un sélecteur de fichier
// et installe l'image comme icône du bouton. Aucun autre lecteur n'exécute ce
// JS. On reproduit le RÉSULTAT d'Acrobat : l'image devient un XObject, posé
// dans un formulaire d'apparence (`/AP /N`) ajusté au rectangle du bouton et
// référencé comme icône (`/MK /I`). Acrobat relit cette structure telle quelle.

const FIELD_FLAG_PUSHBUTTON: i64 = 1 << 16;
/// Côté max (px) conservé pour les images non-JPEG (recompressées en Flate).
const MAX_ICON_SIDE: u32 = 2400;

/// Nom complet d'un champ (`parent.enfant`), comme le construit PDF.js.
fn qualified_field_name(doc: &Document, widget: &Dictionary) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<Dictionary> = Some(widget.clone());
    let mut depth = 0;
    while let Some(dict) = current {
        if let Ok(name) = dict.get(b"T").and_then(Object::as_str) {
            parts.push(decode_pdf_text(name));
        }
        depth += 1;
        if depth > 32 {
            break;
        }
        current = dict
            .get(b"Parent")
            .ok()
            .and_then(|parent| doc.dereference(parent).ok())
            .and_then(|(_, obj)| obj.as_dict().ok())
            .cloned();
    }
    parts.reverse();
    parts.join(".")
}

/// Attribut héritable (`/FT`, `/Ff`…) : cherché sur le widget puis ses parents.
fn inherited_attr(doc: &Document, widget: &Dictionary, key: &[u8]) -> Option<Object> {
    let mut current: Option<Dictionary> = Some(widget.clone());
    let mut depth = 0;
    while let Some(dict) = current {
        if let Ok(value) = dict.get(key) {
            return doc.dereference(value).ok().map(|(_, obj)| obj.clone());
        }
        depth += 1;
        if depth > 32 {
            break;
        }
        current = dict
            .get(b"Parent")
            .ok()
            .and_then(|parent| doc.dereference(parent).ok())
            .and_then(|(_, obj)| obj.as_dict().ok())
            .cloned();
    }
    None
}

fn decode_pdf_text(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn widget_field_type(doc: &Document, widget: &Dictionary) -> Option<Vec<u8>> {
    inherited_attr(doc, widget, b"FT")
        .and_then(|ft| ft.as_name().ok().map(|name| name.to_vec()))
}

fn widget_is_signature(doc: &Document, widget: &Dictionary) -> bool {
    widget_field_type(doc, widget).as_deref() == Some(b"Sig")
}

fn widget_is_pushbutton(doc: &Document, widget: &Dictionary) -> bool {
    if widget_field_type(doc, widget).as_deref() != Some(b"Btn") {
        return false;
    }
    let flags = inherited_attr(doc, widget, b"Ff")
        .and_then(|ff| ff.as_i64().ok())
        .unwrap_or(0);
    flags & FIELD_FLAG_PUSHBUTTON != 0
}

/// Boutons image (`/Btn` poussoir) ou champs de signature (`/Sig`).
fn find_stampable_widgets(doc: &Document, field_name: &str) -> Vec<ObjectId> {
    let mut found = Vec::new();
    for (_, page_id) in doc.get_pages() {
        let Ok(page) = doc.get_dictionary(page_id) else {
            continue;
        };
        let Ok(annots) = page.get(b"Annots") else {
            continue;
        };
        let Ok((_, annots)) = doc.dereference(annots) else {
            continue;
        };
        let Ok(annots) = annots.as_array() else {
            continue;
        };
        for annot in annots {
            let Ok(widget_id) = annot.as_reference() else {
                continue;
            };
            let Ok(widget) = doc.get_dictionary(widget_id) else {
                continue;
            };
            let is_widget = widget
                .get(b"Subtype")
                .and_then(Object::as_name)
                .map(|name| name == b"Widget")
                .unwrap_or(false);
            if !is_widget {
                continue;
            }
            if !widget_is_pushbutton(doc, widget) && !widget_is_signature(doc, widget) {
                continue;
            }
            if qualified_field_name(doc, widget) == field_name {
                found.push(widget_id);
            }
        }
    }
    found
}

struct EmbeddedImage {
    id: ObjectId,
    width: u32,
    height: u32,
}

/// Orientation EXIF d'un JPEG (1 = normale). Les photos téléphone verticales
/// sont souvent stockées en paysage + tag 6 : sans rotation, le PDF les
/// affiche couchées et elles remplissent toute la largeur du cadre.
fn jpeg_exif_orientation(bytes: &[u8]) -> u8 {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return 1;
    }
    let mut cursor = 2usize;
    while cursor + 4 <= bytes.len() {
        if bytes[cursor] != 0xFF {
            break;
        }
        let marker = bytes[cursor + 1];
        if marker == 0xDA {
            break;
        }
        let len = u16::from_be_bytes([bytes[cursor + 2], bytes[cursor + 3]]) as usize;
        if len < 2 || cursor + 2 + len > bytes.len() {
            break;
        }
        if marker == 0xE1 && len >= 8 {
            let payload = &bytes[cursor + 4..cursor + 2 + len];
            if payload.starts_with(b"Exif\0\0") {
                if let Some(orientation) = tiff_orientation(&payload[6..]) {
                    return orientation;
                }
            }
        }
        cursor += 2 + len;
    }
    1
}

fn tiff_orientation(tiff: &[u8]) -> Option<u8> {
    if tiff.len() < 8 {
        return None;
    }
    let le = tiff[0] == b'I' && tiff[1] == b'I';
    if !le && !(tiff[0] == b'M' && tiff[1] == b'M') {
        return None;
    }
    let u16_at = |offset: usize| -> Option<u16> {
        let bytes = tiff.get(offset..offset + 2)?;
        Some(if le {
            u16::from_le_bytes([bytes[0], bytes[1]])
        } else {
            u16::from_be_bytes([bytes[0], bytes[1]])
        })
    };
    let u32_at = |offset: usize| -> Option<u32> {
        let bytes = tiff.get(offset..offset + 4)?;
        Some(if le {
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        } else {
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        })
    };
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for index in 0..count {
        let entry = ifd + 2 + index * 12;
        if u16_at(entry)? != 0x0112 {
            continue;
        }
        let value = u16_at(entry + 8)?;
        if (1..=8).contains(&value) {
            return Some(value as u8);
        }
    }
    None
}

fn apply_exif_orientation(image: image::DynamicImage, orientation: u8) -> image::DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate90().flipv(),
        8 => image.rotate270(),
        _ => image,
    }
}

/// Embarque l'image comme XObject : JPEG droit (orientation 1) passé tel quel
/// (DCTDecode), sinon RGB 8 bits compressé Flate (+ SMask si canal alpha).
fn add_image_xobject(doc: &mut Document, image_bytes: &[u8]) -> Result<EmbeddedImage, String> {
    let format = image::guess_format(image_bytes).map_err(|e| format!("Image illisible : {e}"))?;
    let decoded = image::load_from_memory_with_format(image_bytes, format)
        .map_err(|e| format!("Image illisible : {e}"))?;
    let orientation = if format == image::ImageFormat::Jpeg {
        jpeg_exif_orientation(image_bytes)
    } else {
        1
    };

    if format == image::ImageFormat::Jpeg
        && orientation == 1
        && matches!(decoded.color(), image::ColorType::Rgb8)
    {
        let dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => decoded.width() as i64,
            "Height" => decoded.height() as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        };
        let id = doc.add_object(Stream::new(dict, image_bytes.to_vec()).with_compression(false));
        return Ok(EmbeddedImage {
            id,
            width: decoded.width(),
            height: decoded.height(),
        });
    }

    let decoded = apply_exif_orientation(decoded, orientation);
    let decoded = if decoded.width() > MAX_ICON_SIDE || decoded.height() > MAX_ICON_SIDE {
        decoded.resize(MAX_ICON_SIDE, MAX_ICON_SIDE, image::imageops::FilterType::Triangle)
    } else {
        decoded
    };
    let (width, height) = (decoded.width(), decoded.height());
    let has_alpha = decoded.color().has_alpha();
    let rgba = decoded.to_rgba8();
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    let mut alpha = Vec::with_capacity((width * height) as usize);
    for pixel in rgba.pixels() {
        rgb.extend_from_slice(&pixel.0[..3]);
        alpha.push(pixel.0[3]);
    }

    let mut image_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => width as i64,
        "Height" => height as i64,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
    };
    if has_alpha && alpha.iter().any(|a| *a != 255) {
        let mask_dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        };
        let mut mask = Stream::new(mask_dict, alpha);
        let _ = mask.compress();
        let mask_id = doc.add_object(mask);
        image_dict.set("SMask", Object::Reference(mask_id));
    }
    let mut stream = Stream::new(image_dict, rgb);
    let _ = stream.compress();
    let id = doc.add_object(stream);
    Ok(EmbeddedImage { id, width, height })
}

fn widget_rect_size(doc: &Document, widget_id: ObjectId) -> Result<(f32, f32), String> {
    let widget = doc.get_dictionary(widget_id).map_err(|e| e.to_string())?;
    let rect = widget.get(b"Rect").map_err(|e| e.to_string())?;
    let (_, rect) = doc.dereference(rect).map_err(|e| e.to_string())?;
    let values: Vec<f32> = rect
        .as_array()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|v| {
            v.as_float()
                .ok()
                .or_else(|| v.as_i64().ok().map(|n| n as f32))
        })
        .collect();
    if values.len() != 4 {
        return Err("Rectangle du bouton invalide.".into());
    }
    Ok(((values[2] - values[0]).abs(), (values[3] - values[1]).abs()))
}

/// Formulaire d'apparence : l'image centrée, ratio conservé, inscrite dans le
/// cadre (jamais étirée). Un portrait ne prend pas toute la largeur d'un cadre
/// plus large que lui.
fn add_icon_form(
    doc: &mut Document,
    image: &EmbeddedImage,
    width: f32,
    height: f32,
    fill_white: bool,
) -> ObjectId {
    let (iw, ih) = (image.width.max(1) as f32, image.height.max(1) as f32);
    let pad = 2.0_f32.min(width.min(height) * 0.04);
    let inner_w = (width - 2.0 * pad).max(1.0);
    let inner_h = (height - 2.0 * pad).max(1.0);
    let scale = (inner_w / iw).min(inner_h / ih);
    let drawn_w = iw * scale;
    let drawn_h = ih * scale;
    let tx = pad + (inner_w - drawn_w) / 2.0;
    let ty = pad + (inner_h - drawn_h) / 2.0;
    let draw = format!(
        "q {drawn_w:.3} 0 0 {drawn_h:.3} {tx:.3} {ty:.3} cm /Im0 Do Q\n"
    );
    let content = if fill_white {
        format!("q 1 1 1 rg 0 0 {width:.3} {height:.3} re f Q\n{draw}")
    } else {
        draw
    };
    let dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "FormType" => 1,
        "BBox" => vec![0.into(), 0.into(), Object::Real(width), Object::Real(height)],
        "Resources" => dictionary! {
            "XObject" => dictionary! { "Im0" => Object::Reference(image.id) },
        },
    };
    doc.add_object(Stream::new(dict, content.into_bytes()))
}

/// PDF.js (qui écrit /V et /AP quand on remplit un champ dans Slate) trace
/// toujours un cadre rectangulaire, y compris pour les champs à bordure
/// « soulignée » (`/BS /S /U`) : à l'impression, les champs remplis auraient
/// une boîte là où le formulaire dessine un simple trait. On ramène ces cadres
/// à un trait bas. Renvoie les octets inchangés si rien n'est à corriger.
pub fn normalize_form_appearances(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    let mut doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;

    let mut streams: Vec<ObjectId> = Vec::new();
    for (_, page_id) in doc.get_pages() {
        let Ok(page) = doc.get_dictionary(page_id) else {
            continue;
        };
        let annots: Vec<ObjectId> = page
            .get(b"Annots")
            .ok()
            .and_then(|annots| doc.dereference(annots).ok())
            .and_then(|(_, annots)| annots.as_array().ok())
            .map(|annots| annots.iter().filter_map(|a| a.as_reference().ok()).collect())
            .unwrap_or_default();
        for widget_id in annots {
            let Ok(widget) = doc.get_dictionary(widget_id) else {
                continue;
            };
            let is_text = inherited_attr(&doc, widget, b"FT")
                .and_then(|ft| ft.as_name().ok().map(|name| name == b"Tx"))
                .unwrap_or(false);
            if !is_text {
                continue;
            }
            let underlined = widget
                .get(b"BS")
                .ok()
                .and_then(|bs| doc.dereference(bs).ok())
                .and_then(|(_, bs)| bs.as_dict().ok())
                .and_then(|bs| bs.get(b"S").ok())
                .and_then(|style| style.as_name().ok())
                .map(|style| style == b"U")
                .unwrap_or(false);
            if !underlined {
                continue;
            }
            let normal = widget
                .get(b"AP")
                .ok()
                .and_then(|ap| doc.dereference(ap).ok())
                .and_then(|(_, ap)| ap.as_dict().ok())
                .and_then(|ap| ap.get(b"N").ok())
                .and_then(|n| n.as_reference().ok());
            if let Some(stream_id) = normal {
                streams.push(stream_id);
            }
        }
    }

    // Préfixe exact émis par PDF.js : `/Tx BMC q <lw> w <couleur> RG|G|K <x> <y> <w> <h> re S`.
    let frame = regex::Regex::new(
        r"^/Tx BMC q (?P<lw>[\d.]+) w (?P<color>(?:[\d.]+ ){1,4}(?:RG|G|K)) (?P<x>[\d.-]+) (?P<y>[\d.-]+) (?P<w>[\d.]+) (?P<h>[\d.]+) re S",
    )
    .map_err(|e| e.to_string())?;

    let mut changed = false;
    for stream_id in streams {
        let Ok(Object::Stream(stream)) = doc.get_object_mut(stream_id) else {
            continue;
        };
        let Ok(content) = stream.get_plain_content() else {
            continue;
        };
        let text = String::from_utf8_lossy(&content).into_owned();
        let Some(caps) = frame.captures(&text) else {
            continue;
        };
        let lw: f32 = caps["lw"].parse().unwrap_or(1.0);
        let x: f32 = caps["x"].parse().unwrap_or(0.0);
        let width: f32 = caps["w"].parse().unwrap_or(0.0);
        let y = lw / 2.0;
        let underline = format!(
            "/Tx BMC q {lw} w {} {x:.3} {y:.3} m {:.3} {y:.3} l S",
            &caps["color"],
            x + width
        );
        let rewritten = format!("{underline}{}", &text[caps.get(0).map(|m| m.end()).unwrap_or(0)..]);
        stream.set_plain_content(rewritten.into_bytes());
        changed = true;
    }

    if !changed {
        return Ok(bytes.to_vec());
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Installe `image_bytes` (PNG/JPEG) comme icône du bouton poussoir `field_name`
/// et renvoie le PDF modifié.
pub fn set_form_button_image(
    bytes: &[u8],
    field_name: &str,
    image_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    if image_bytes.is_empty() {
        return Err("Aucune image fournie.".into());
    }
    let mut doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;
    let widgets = find_stampable_widgets(&doc, field_name);
    if widgets.is_empty() {
        return Err(format!("Champ image ou signature « {field_name} » introuvable."));
    }
    let image = add_image_xobject(&mut doc, image_bytes)?;
    for widget_id in widgets {
        let fill_white = doc
            .get_dictionary(widget_id)
            .map(|widget| !widget_is_signature(&doc, widget))
            .unwrap_or(true);
        let (width, height) = widget_rect_size(&doc, widget_id)?;
        let form_id = add_icon_form(&mut doc, &image, width, height, fill_white);
        let existing_mk = doc
            .get_dictionary(widget_id)
            .ok()
            .and_then(|widget| widget.get(b"MK").ok())
            .and_then(|mk| doc.dereference(mk).ok())
            .and_then(|(_, mk)| mk.as_dict().ok())
            .cloned();
        let mut mk = existing_mk.unwrap_or_default();
        // /I = l'image brute ; /IF impose un scale proportionnel si un lecteur
        // régénère l'apparence (Acrobat / PDF.js saveDocument étirent sinon).
        mk.set("I", Object::Reference(image.id));
        mk.set(
            "IF",
            dictionary! {
                "SW" => "A",
                "S" => "P",
                "A" => vec![Object::Real(0.5), Object::Real(0.5)],
                "FB" => false,
            },
        );
        mk.set("TP", 1);
        let widget = doc.get_dictionary_mut(widget_id).map_err(|e| e.to_string())?;
        widget.set("AP", dictionary! { "N" => Object::Reference(form_id) });
        widget.set("MK", Object::Dictionary(mk));
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
