//! Messages du moteur destinés à l'utilisateur (erreurs, libellés renvoyés).
//!
//! Le moteur ne détecte pas la langue lui-même (il tourne aussi en WASM) :
//! l'application hôte la fixe avec [`set_language`]. Anglais par défaut, repli
//! sur l'anglais pour une clé absente d'une table.

use std::fmt::Display;
use std::sync::RwLock;

static LANGUAGE: RwLock<&str> = RwLock::new("en");

/// Langue des messages du moteur (`"fr"`, `"en"`…). Une langue sans table
/// retombe sur l'anglais.
pub fn set_language(lang: &str) {
    let lang = if lang == "fr" { "fr" } else { "en" };
    if let Ok(mut current) = LANGUAGE.write() {
        *current = lang;
    }
}

/// Remplace chaque `{nom}` de `template` par la valeur associée dans `args`.
pub fn fill(template: &str, args: &[(&str, &dyn Display)]) -> String {
    let mut out = template.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), &value.to_string());
    }
    out
}

/// Message `key` dans la langue courante, arguments substitués.
pub(crate) fn msg(key: &'static str, args: &[(&str, &dyn Display)]) -> String {
    let lang = LANGUAGE.read().map(|l| *l).unwrap_or("en");
    let table = if lang == "fr" { FR } else { EN };
    let template = lookup(table, key)
        .or_else(|| lookup(EN, key))
        .unwrap_or(key);
    fill(template, args)
}

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

const EN: &[(&str, &str)] = &[
    ("invalidButtonRect", "Invalid button rectangle."),
    ("noImageProvided", "No image provided."),
    (
        "imageFieldNotFound",
        "Image or signature field “{field}” not found.",
    ),
    ("labelNotPdf", "The document to analyze is not a valid PDF."),
    (
        "analysisDpiRange",
        "Analysis resolution out of range (36 to 300 dpi).",
    ),
    ("pagesOneBased", "Pages are numbered from 1."),
    ("invalidPageSize", "Invalid page dimensions."),
    ("emptyAnalysisRender", "Empty analysis render."),
    ("unnamedFont", "Unnamed"),
    ("securityPassword", "Password"),
    ("securityNone", "None"),
    ("emptyWatermark", "The watermark text is empty."),
    ("wrongPassword", "Wrong password or unreadable PDF."),
    (
        "cropTooLarge",
        "The crop margins are too large for this page.",
    ),
    ("noImagesInDocument", "No images found in this document."),
    ("redactNoTerms", "Provide at least one term to redact."),
    ("saveFailed", "Could not save: {e}"),
    ("documentNoPages", "The document has no pages."),
];

const FR: &[(&str, &str)] = &[
    ("invalidButtonRect", "Rectangle du bouton invalide."),
    ("noImageProvided", "Aucune image fournie."),
    (
        "imageFieldNotFound",
        "Champ image ou signature « {field} » introuvable.",
    ),
    (
        "labelNotPdf",
        "Le document à analyser n'est pas un PDF valide.",
    ),
    (
        "analysisDpiRange",
        "Résolution d'analyse hors plage (36 à 300 dpi).",
    ),
    ("pagesOneBased", "Les pages sont numérotées à partir de 1."),
    ("invalidPageSize", "Dimensions de page invalides."),
    ("emptyAnalysisRender", "Rendu d'analyse vide."),
    ("unnamedFont", "Sans nom"),
    ("securityPassword", "Mot de passe"),
    ("securityNone", "Aucune"),
    ("emptyWatermark", "Le texte du filigrane est vide."),
    ("wrongPassword", "Mot de passe incorrect ou PDF illisible."),
    (
        "cropTooLarge",
        "Les marges de rognage sont trop grandes pour cette page.",
    ),
    (
        "noImagesInDocument",
        "Aucune image trouvée dans ce document.",
    ),
    ("redactNoTerms", "Fournis au moins un terme à caviarder."),
    ("saveFailed", "Sauvegarde impossible : {e}"),
    ("documentNoPages", "Document sans page."),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_have_the_same_keys() {
        for (key, _) in EN {
            assert!(lookup(FR, key).is_some(), "fr is missing {key}");
        }
        for (key, _) in FR {
            assert!(lookup(EN, key).is_some(), "fr has unknown key {key}");
        }
    }

    #[test]
    fn fill_substitutes_named_arguments() {
        let page = 3;
        assert_eq!(
            fill("Page {p} of {n}: {p}", &[("p", &page), ("n", &"7")]),
            "Page 3 of 7: 3"
        );
    }
}
