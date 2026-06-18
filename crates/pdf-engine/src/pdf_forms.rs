//! Remplissage de formulaires AcroForm via PDFium.
//!
//! PDFium sait écrire la valeur (`/V`) des champs texte/cases/radios, mais ne
//! régénère pas l'apparence visible. On active donc `NeedAppearances` en
//! post-passe (lopdf) pour que la saisie s'affiche dans tous les lecteurs.
//! Les listes déroulantes / listes (combo/list) sont exposées en lecture seule
//! (pdfium-render 0.9.1 n'offre pas de setter pour ces types).

use std::collections::HashMap;

use lopdf::{Document, Object};
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
