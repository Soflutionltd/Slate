//! Énumération des polices installées sur la machine, pour peupler le sélecteur
//! de police de l'éditeur. L'éditeur aplatit le rendu en image à l'export, donc
//! il suffit que la police soit présente côté système : le webview la dessine
//! nativement et le bitmap exporté la capture (aucun embarquement PDF requis ici).

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
