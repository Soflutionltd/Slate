//! Langue et région de l'interface native (barre de menus, dialogues).
//!
//! - Réglage Slate : "auto" (suit le système) ou une langue forcée, choisi dans
//!   le WebView et persisté ici pour être connu avant le chargement de la page.
//! - Préférences système : langues préférées et région, lues dans le domaine
//!   global (un `AppleLanguages` forcé pour Slate ne les masque donc pas).

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

}
