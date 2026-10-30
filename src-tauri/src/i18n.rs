//! Langue et région de l'interface native (barre de menus, dialogues).
//!
//! - Réglage Slate : "auto" (suit le système) ou une langue forcée, choisi dans
//!   le WebView et persisté ici pour être connu avant le chargement de la page.
//! - Préférences système : langues préférées et région, lues dans le domaine
//!   global (un `AppleLanguages` forcé pour Slate ne les masque donc pas).
//! - Libellés : une table par langue, repli sur l'anglais — même modèle que la
//!   table `translations` de frontend-dist/app.js.

use std::path::PathBuf;

/// Langues disposant d'une traduction (frontend et menus natifs).
pub const SUPPORTED: &[&str] = &["en", "fr"];

/// Langues préférées (tags BCP-47, ordre de préférence) et région (ISO 3166).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct SystemLocale {
    pub languages: Vec<String>,
    pub region: Option<String>,
}

fn setting_path() -> Option<PathBuf> {
    Some(
        dirs::data_dir()?
            .join("com.soflution.slate")
            .join("native-language"),
    )
}

/// Persiste le réglage de langue ("auto" ou une langue forcée).
pub fn persist_setting(lang: &str) {
    let Some(path) = setting_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = if lang.trim().is_empty() {
        "auto"
    } else {
        lang.trim()
    };
    let _ = std::fs::write(&path, value);
}

/// Langue forcée par l'utilisateur, ou `None` en mode automatique.
pub fn forced_language() -> Option<String> {
    let raw = std::fs::read_to_string(setting_path()?).ok()?;
    let value = raw.trim();
    (!value.is_empty() && value != "auto").then(|| value.to_string())
}

/// Sous-étiquette de langue d'un tag (`en-AU`, `fr_CA.UTF-8` → `en`, `fr`).
pub fn primary_language(tag: &str) -> String {
    tag.split(['-', '_', '.', '@'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Langue d'interface : la langue forcée si elle est traduite, sinon la première
/// langue système traduite, sinon l'anglais.
pub fn resolve_language(forced: Option<&str>, system_languages: &[String]) -> &'static str {
    forced
        .into_iter()
        .map(primary_language)
        .chain(system_languages.iter().map(|tag| primary_language(tag)))
        .find_map(|lang| SUPPORTED.iter().copied().find(|s| *s == lang))
        .unwrap_or("en")
}

pub fn ui_language() -> &'static str {
    resolve_language(forced_language().as_deref(), &system_locale().languages)
}

/// Région d'un identifiant de locale : `en_AU` → AU ; `en_US@rg=auzzzz` → AU
/// (région choisie séparément de la langue) ; `en_AU.UTF-8` → AU.
pub fn region_from_locale_id(id: &str) -> Option<String> {
    if let Some((_, keywords)) = id.split_once('@') {
        for keyword in keywords.split(';') {
            if let Some(value) = keyword.strip_prefix("rg=") {
                if value.len() >= 2 && value.is_char_boundary(2) {
                    return Some(value[..2].to_ascii_uppercase());
                }
            }
        }
    }
    let base = id.split(['@', '.']).next().unwrap_or_default();
    base.split(['_', '-'])
        .skip(1)
        .find(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|part| part.to_ascii_uppercase())
}

#[cfg(target_os = "macos")]
pub fn system_locale() -> SystemLocale {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    extern "C" {
        static kCFPreferencesAnyApplication: CFStringRef;
        fn CFPreferencesCopyAppValue(
            key: CFStringRef,
            application_id: CFStringRef,
        ) -> *const c_void;
    }

    // Domaine global (« toutes les applications ») : ignore l'override
    // AppleLanguages que Slate écrit dans son propre domaine.
    let global_value = |key: &str| -> Option<CFType> {
        let key = CFString::new(key);
        let value = unsafe {
            CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), kCFPreferencesAnyApplication)
        };
        (!value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) })
    };

    let languages = global_value("AppleLanguages")
        .and_then(|value| value.downcast_into::<CFArray>())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    unsafe { CFType::wrap_under_get_rule(*item) }.downcast::<CFString>()
                })
                .map(|tag| tag.to_string())
                .collect()
        })
        .unwrap_or_default();
    let region = global_value("AppleLocale")
        .and_then(|value| value.downcast::<CFString>())
        .and_then(|id| region_from_locale_id(&id.to_string()));
    SystemLocale { languages, region }
}

#[cfg(not(target_os = "macos"))]
pub fn system_locale() -> SystemLocale {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty() && value != "C" && value != "POSIX")
        .unwrap_or_default();
    let tag = locale
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .replace('_', "-");
    SystemLocale {
        languages: if tag.is_empty() {
            Vec::new()
        } else {
            vec![tag]
        },
        region: region_from_locale_id(&locale),
    }
}

/// Script injecté avant la page : le WebView connaît ainsi langues et région
/// système dès le premier rendu (`navigator.languages` reflète l'override
/// AppleLanguages de Slate, pas les préférences système, et ignore la région).
pub fn js_init_script() -> String {
    let json = serde_json::to_string(&system_locale()).unwrap_or_else(|_| "{}".into());
    format!("window.__SLATE_LOCALE__ = {json};")
}

/// Libellé natif `key` dans `lang` (repli sur l'anglais, puis sur la clé).
pub fn tr(lang: &str, key: &'static str) -> &'static str {
    let table = match lang {
        "fr" => FR,
        _ => EN,
    };
    lookup(table, key)
        .or_else(|| lookup(EN, key))
        .unwrap_or(key)
}

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

const EN: &[(&str, &str)] = &[
    ("menu.about", "About Slate"),
    ("menu.aboutPlugins", "About Slate Plug-ins..."),
    ("menu.preferences", "Preferences..."),
    (
        "menu.accessibilitySetup",
        "Accessibility Setup Assistant...",
    ),
    ("menu.services", "Services"),
    ("menu.noServices", "No Services Available"),
    ("menu.hide", "Hide Slate"),
    ("menu.hideOthers", "Hide Others"),
    ("menu.showAll", "Show All"),
    ("menu.quit", "Quit Slate"),
    ("menu.file", "File"),
    ("menu.open", "Open..."),
    ("menu.openRecent", "Open Recent Files"),
    ("menu.allRecent", "All Recent Files..."),
    ("menu.create", "Create"),
    ("menu.createPdf", "Create PDF"),
    ("menu.createBlank", "Create Blank Page"),
    ("menu.combineFiles", "Combine Files"),
    ("menu.save", "Save"),
    ("menu.saveAs", "Save As..."),
    ("menu.saveAsOther", "Save As Other"),
    ("menu.editedPdf", "Edited PDF"),
    ("menu.jsonNotes", "JSON Notes"),
    ("menu.compressPdf", "Compress PDF"),
    ("menu.exportPdf", "Export a PDF"),
    ("menu.editedPdfEllipsis", "Edited PDF..."),
    ("menu.image", "Image"),
    ("menu.protectPassword", "Protect Using Password"),
    ("menu.requestSignatures", "Request E-signatures"),
    ("menu.shareFile", "Share File"),
    ("menu.print", "Print..."),
    ("menu.find", "Find"),
    ("menu.advancedSearch", "Advanced Search"),
    ("menu.documentProperties", "Document Properties..."),
    ("menu.closeFile", "Close File"),
    ("menu.edit", "Edit"),
    ("menu.undo", "Undo  ⌘Z"),
    ("menu.redo", "Redo  ⌘Y"),
    ("menu.undoRedoMore", "Undo, Redo & More"),
    ("menu.cut", "Cut"),
    ("menu.copy", "Copy"),
    ("menu.paste", "Paste"),
    ("menu.selectAll", "Select All"),
    ("menu.editPdf", "Edit PDF"),
    ("menu.addText", "Add Text"),
    ("menu.addImage", "Add Image"),
    ("menu.fromFile", "From File..."),
    ("menu.addSignature", "Add Signature"),
    ("menu.deletePage", "Delete Page"),
    ("menu.rotatePageCw", "Rotate Page (Clockwise)"),
    ("menu.rotatePageCcw", "Rotate Page (Counterclockwise)"),
    ("menu.organizePages", "Organize Pages"),
    ("menu.redactPdf", "Redact a PDF"),
    ("menu.scanOcr", "Scan & OCR"),
    ("menu.prepareForm", "Prepare Form"),
    ("menu.protection", "Protection"),
    ("menu.addPassword", "Add Password"),
    ("menu.specialCharacters", "Special Characters..."),
    ("menu.view", "View"),
    ("menu.rotateView", "Rotate View"),
    ("menu.clockwise", "Clockwise"),
    ("menu.counterclockwise", "Counterclockwise"),
    ("menu.pageNavigation", "Page Navigation"),
    ("menu.previousPage", "Previous Page"),
    ("menu.nextPage", "Next Page"),
    ("menu.display", "Display"),
    ("menu.allTools", "All Tools"),
    ("menu.sidePanels", "Side Panels"),
    ("menu.zoom", "Zoom"),
    ("menu.fitWidth", "Fit Width"),
    ("menu.zoomIn", "Zoom In"),
    ("menu.zoomOut", "Zoom Out"),
    ("menu.showHide", "Show/Hide"),
    ("menu.rightToolbar", "Right Toolbar"),
    ("menu.displayTheme", "Display Theme"),
    ("menu.themeSystem", "System"),
    ("menu.themeLight", "Light"),
    ("menu.audio", "Read Out Loud"),
    ("menu.readAloud", "Read Aloud"),
    ("menu.prepress", "Use Print Production"),
    ("menu.convertColors", "Convert Colors…"),
    ("menu.openPrepress", "Open Print Production Panel"),
    ("menu.readingMode", "Reading Mode"),
    ("menu.fullScreen", "Full Screen Mode"),
    ("menu.disableNewAcrobat", "Disable New Acrobat"),
    ("menu.tracker", "Tracker..."),
    ("menu.window", "Window"),
    ("menu.fill", "Fill"),
    ("menu.center", "Center"),
    ("menu.moveResize", "Move & Resize"),
    ("menu.left", "Left"),
    ("menu.right", "Right"),
    ("menu.moveToMainDisplay", "Move to Main Display"),
    ("menu.newWindow", "New Window"),
    ("menu.cascade", "Cascade"),
    ("menu.tile", "Tile"),
    ("menu.horizontally", "Horizontally"),
    ("menu.vertically", "Vertically"),
    ("menu.minimize", "Minimize"),
    ("menu.slateDocument", "Slate Document"),
    ("menu.help", "Help"),
    ("menu.search", "Search"),
    ("menu.aiHelp", "How to Use the AI Assistant"),
    ("menu.editPdfHelp", "“Edit a PDF” Help"),
    ("menu.slateHelp", "Slate Help"),
    ("menu.tutorials", "Slate Tutorials"),
    ("menu.manageAccount", "Manage My Account..."),
    ("menu.checkUpdates", "Check for Updates"),
];

const FR: &[(&str, &str)] = &[
    ("menu.about", "À propos de Slate"),
    (
        "menu.aboutPlugins",
        "À propos des modules externes Slate...",
    ),
    ("menu.preferences", "Préférences..."),
    (
        "menu.accessibilitySetup",
        "Assistant de configuration d’accessibilité...",
    ),
    ("menu.services", "Services"),
    ("menu.noServices", "Aucun service disponible"),
    ("menu.hide", "Masquer Slate"),
    ("menu.hideOthers", "Masquer les autres"),
    ("menu.showAll", "Afficher tout"),
    ("menu.quit", "Quitter Slate"),
    ("menu.file", "Fichier"),
    ("menu.open", "Ouvrir..."),
    ("menu.openRecent", "Ouvrir les fichiers récents"),
    ("menu.allRecent", "Tous les fichiers récents..."),
    ("menu.create", "Créer"),
    ("menu.createPdf", "Créer un PDF"),
    ("menu.createBlank", "Créer une page vierge"),
    ("menu.combineFiles", "Combiner les fichiers"),
    ("menu.save", "Enregistrer"),
    ("menu.saveAs", "Enregistrer sous..."),
    ("menu.saveAsOther", "Enregistrer sous un autre"),
    ("menu.editedPdf", "PDF modifié"),
    ("menu.jsonNotes", "Notes JSON"),
    ("menu.compressPdf", "Compresser un fichier PDF"),
    ("menu.exportPdf", "Exporter un PDF"),
    ("menu.editedPdfEllipsis", "PDF modifié..."),
    ("menu.image", "Image"),
    (
        "menu.protectPassword",
        "Protéger à l’aide d’un mot de passe",
    ),
    (
        "menu.requestSignatures",
        "Demander des signatures électroniques",
    ),
    ("menu.shareFile", "Partager le fichier"),
    ("menu.print", "Imprimer..."),
    ("menu.find", "Rechercher"),
    ("menu.advancedSearch", "Recherche avancée"),
    ("menu.documentProperties", "Propriétés du document..."),
    ("menu.closeFile", "Fermer le fichier"),
    ("menu.edit", "Édition"),
    ("menu.undo", "Annuler  ⌘Z"),
    ("menu.redo", "Rétablir  ⌘Y"),
    ("menu.undoRedoMore", "Annuler, rétablir et plus encore"),
    ("menu.cut", "Couper"),
    ("menu.copy", "Copier"),
    ("menu.paste", "Coller"),
    ("menu.selectAll", "Tout sélectionner"),
    ("menu.editPdf", "Modifier le PDF"),
    ("menu.addText", "Ajouter du texte"),
    ("menu.addImage", "Ajouter une image"),
    ("menu.fromFile", "Depuis un fichier..."),
    ("menu.addSignature", "Ajouter une signature"),
    ("menu.deletePage", "Supprimer la page"),
    ("menu.rotatePageCw", "Faire pivoter la page (horaire)"),
    ("menu.rotatePageCcw", "Faire pivoter la page (antihoraire)"),
    ("menu.organizePages", "Organiser les pages"),
    ("menu.redactPdf", "Biffer un PDF"),
    ("menu.scanOcr", "Scan et OCR"),
    ("menu.prepareForm", "Préparer le formulaire"),
    ("menu.protection", "Protection"),
    ("menu.addPassword", "Ajouter un mot de passe"),
    ("menu.specialCharacters", "Caractères spéciaux..."),
    ("menu.view", "Affichage"),
    ("menu.rotateView", "Faire pivoter la vue"),
    ("menu.clockwise", "Horaire"),
    ("menu.counterclockwise", "Antihoraire"),
    ("menu.pageNavigation", "Navigation de pages"),
    ("menu.previousPage", "Page précédente"),
    ("menu.nextPage", "Page suivante"),
    ("menu.display", "Affichage"),
    ("menu.allTools", "Tous les outils"),
    ("menu.sidePanels", "Panneaux latéraux"),
    ("menu.zoom", "Zoom"),
    ("menu.fitWidth", "Largeur page"),
    ("menu.zoomIn", "Zoom avant"),
    ("menu.zoomOut", "Zoom arrière"),
    ("menu.showHide", "Afficher/Masquer"),
    ("menu.rightToolbar", "Barre d’outils droite"),
    ("menu.displayTheme", "Thème d’affichage"),
    ("menu.themeSystem", "Système"),
    ("menu.themeLight", "Clair"),
    ("menu.audio", "Lecture audio"),
    ("menu.readAloud", "Lire à voix haute"),
    ("menu.prepress", "Utiliser le prépresse"),
    ("menu.convertColors", "Convertir les couleurs…"),
    ("menu.openPrepress", "Ouvrir le panneau prépresse"),
    ("menu.readingMode", "Mode Lecture"),
    ("menu.fullScreen", "Mode plein écran"),
    (
        "menu.disableNewAcrobat",
        "Désactiver la nouvelle version d’Acrobat",
    ),
    ("menu.tracker", "Dispositif de suivi..."),
    ("menu.window", "Fenêtre"),
    ("menu.fill", "Remplir"),
    ("menu.center", "Centrer"),
    ("menu.moveResize", "Déplacer et redimensionner"),
    ("menu.left", "Vers la gauche"),
    ("menu.right", "Vers la droite"),
    ("menu.moveToMainDisplay", "Déplacer vers l’écran principal"),
    ("menu.newWindow", "Nouvelle fenêtre"),
    ("menu.cascade", "Cascade"),
    ("menu.tile", "Mosaïque"),
    ("menu.horizontally", "Horizontale"),
    ("menu.vertically", "Verticale"),
    ("menu.minimize", "Réduire"),
    ("menu.slateDocument", "Document Slate"),
    ("menu.help", "Aide"),
    ("menu.search", "Rechercher"),
    ("menu.aiHelp", "Comment utiliser l’Assistant IA"),
    ("menu.editPdfHelp", "Aide “Modifier un PDF”"),
    ("menu.slateHelp", "Aide Slate"),
    ("menu.tutorials", "Tutoriels Slate"),
    ("menu.manageAccount", "Gérer mon compte..."),
    ("menu.checkUpdates", "Rechercher les mises à jour"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn auto_picks_first_translated_system_language() {
        assert_eq!(
            resolve_language(None, &langs(&["de-DE", "fr-CA", "en-US"])),
            "fr"
        );
        assert_eq!(resolve_language(None, &langs(&["en-AU", "fr-FR"])), "en");
        assert_eq!(resolve_language(None, &langs(&["ja-JP"])), "en");
        assert_eq!(resolve_language(None, &[]), "en");
    }

    #[test]
    fn forced_language_wins_over_system() {
        assert_eq!(resolve_language(Some("en"), &langs(&["fr-FR"])), "en");
        assert_eq!(resolve_language(Some("fr"), &langs(&["en-US"])), "fr");
        // Langue forcée non traduite : on retombe sur les langues système.
        assert_eq!(resolve_language(Some("de"), &langs(&["fr-FR"])), "fr");
    }

    #[test]
    fn region_parsing() {
        assert_eq!(region_from_locale_id("en_AU").as_deref(), Some("AU"));
        assert_eq!(
            region_from_locale_id("en_US@rg=auzzzz").as_deref(),
            Some("AU")
        );
        assert_eq!(region_from_locale_id("fr_CA.UTF-8").as_deref(), Some("CA"));
        assert_eq!(region_from_locale_id("zh_Hans_CN").as_deref(), Some("CN"));
        assert_eq!(region_from_locale_id("en"), None);
    }

    #[test]
    fn every_language_table_has_every_english_key() {
        for (lang, table) in [("fr", FR)] {
            for (key, _) in EN {
                assert!(lookup(table, key).is_some(), "{lang} is missing {key}");
            }
            for (key, _) in table {
                assert!(lookup(EN, key).is_some(), "{lang} has unknown key {key}");
            }
        }
    }
}
