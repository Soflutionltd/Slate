//! Énumération des polices installées sur la machine, pour peupler le sélecteur
//! de police de l'éditeur. L'éditeur aplatit le rendu en image à l'export, donc
//! il suffit que la police soit présente côté système : le webview la dessine
//! nativement et le bitmap exporté la capture (aucun embarquement PDF requis ici).

use font_kit::family_name::FamilyName;
use font_kit::handle::Handle;
use font_kit::properties::{Properties, Style, Weight};
use font_kit::source::SystemSource;

/// Retourne la liste triée et dédoublonnée des familles de polices installées.
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut families = source
        .all_families()
        .map_err(|e| format!("Impossible de lister les polices système : {e}"))?;

    // On écarte les familles vides / cachées (préfixe '.') que macOS expose
    // (ex. ".SF NS", ".Helvetica Neue DeskInterface") et qui ne sont pas
    // utilisables dans un document.
    families.retain(|name| {
        let trimmed = name.trim();
        !trimmed.is_empty() && !trimmed.starts_with('.')
    });
    families.sort_by_key(|name| name.to_lowercase());
    families.dedup();
    Ok(families)
}

/// Résout une famille de police installée en octets (TTF/OTF) embarquables dans
/// le PDF lors d'une édition vectorielle. Choisit la fonte la plus proche selon
/// le gras/italique demandés. Retourne `None` si la famille est introuvable ou
/// illisible : l'export retombe alors proprement sur une police standard.
///
/// La police est réduite au sous-ensemble des glyphes de `text` + Latin-1 (voir
/// `pdf_font_subset`) : quelques dizaines de Ko au lieu d'un fichier complet.
/// Les collections macOS (`.ttc`, ex. Helvetica) sont d'abord ramenées à la
/// face sélectionnée — PDFium ne lit sinon que la face 0 de la collection.
pub fn font_data_for_family(family: &str, bold: bool, italic: bool, text: &str) -> Option<Vec<u8>> {
    let family = family.trim();
    if family.is_empty() {
        return None;
    }
    let mut properties = Properties::new();
    if bold {
        properties.weight = Weight::BOLD;
    }
    if italic {
        properties.style = Style::Italic;
    }
    let handle = SystemSource::new()
        .select_best_match(&[FamilyName::Title(family.to_string())], &properties)
        .ok()?;
    let font_index = match &handle {
        Handle::Path { font_index, .. } | Handle::Memory { font_index, .. } => *font_index,
    };
    let font = handle.load().ok()?;
    let data = font.copy_font_data().map(|data| data.as_ref().clone())?;
    let face = if data.starts_with(b"ttcf") {
        alto_pdf_engine::pdf_font_subset::extract_collection_face(&data, font_index)?
    } else {
        data
    };
    match alto_pdf_engine::pdf_font_subset::subset_font(&face, text) {
        Ok(subset) => Some(subset),
        Err(error) => {
            // Police embarquée en entier : rendu identique, fichier plus lourd.
            tracing::warn!("Sous-ensemble impossible pour « {family} » : {error}");
            Some(face)
        }
    }
}
