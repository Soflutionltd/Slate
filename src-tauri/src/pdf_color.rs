//! Conversion couleur PDF (prépresse) via Ghostscript + profil ICC FOGRA39.
//!
//! Cible V1 : **Coated FOGRA39 (ISO 12647-2:2004)** — le profil Adobe installé
//! sur macOS, ou un `ISOcoated_v2_eci.icc` fourni par l'utilisateur.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Résultat d'une conversion couleur.
#[allow(dead_code)]
pub struct ColorConvertResult {
    pub bytes: Vec<u8>,
    pub profile_path: String,
    pub profile_label: String,
}

fn find_ghostscript() -> Result<PathBuf, String> {
    let candidates = [
        "/opt/homebrew/bin/gs",
        "/usr/local/bin/gs",
        "/usr/bin/gs",
    ];
    for path in candidates {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(p);
        }
    }
    // PATH
    if let Ok(output) = Command::new("/usr/bin/which").arg("gs").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                let p = PathBuf::from(text);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
    }
    Err(
        "Ghostscript (gs) est requis pour convertir les couleurs. Installe-le via Homebrew : brew install ghostscript."
            .into(),
    )
}

/// Chemins connus pour Coated FOGRA39 / ISO Coated v2 (ECI).
fn fogra39_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let adobe = PathBuf::from(
        "/Library/Application Support/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc",
    );
    paths.push(adobe);
    if let Some(home) = dirs_next_home() {
        paths.push(home.join("Library/ColorSync/Profiles/CoatedFOGRA39.icc"));
        paths.push(home.join("Library/ColorSync/Profiles/ISOcoated_v2_eci.icc"));
        paths.push(
            home.join("Library/Application Support/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc"),
        );
    }
    paths.push(PathBuf::from("/Library/ColorSync/Profiles/CoatedFOGRA39.icc"));
    paths.push(PathBuf::from("/Library/ColorSync/Profiles/ISOcoated_v2_eci.icc"));
    // Profil optionnel livré avec l'app (si l'utilisateur / ECI le place ici).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(resources) = exe
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("Resources/icc"))
        {
            paths.push(resources.join("CoatedFOGRA39.icc"));
            paths.push(resources.join("ISOcoated_v2_eci.icc"));
        }
    }
    paths
}

fn dirs_next_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn resolve_fogra39_profile(explicit: Option<&str>) -> Result<(PathBuf, String), String> {
    if let Some(path) = explicit {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok((
                p,
                "Coated FOGRA39 (ISO 12647-2:2004)".into(),
            ));
        }
        return Err(format!("Profil ICC introuvable : {path}"));
    }
    for candidate in fogra39_candidates() {
        if candidate.is_file() {
            let label = candidate
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("FOGRA39");
            let pretty = if label.to_ascii_lowercase().contains("iso") {
                "ISO Coated v2 (ECI) — FOGRA39".to_string()
            } else {
                "Coated FOGRA39 (ISO 12647-2:2004)".to_string()
            };
            return Ok((candidate, pretty));
        }
    }
    Err(
        "Profil Coated FOGRA39 introuvable. Il est fourni avec Adobe Acrobat \
(Library/Application Support/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc) \
ou place ISOcoated_v2_eci.icc (ECI) dans ~/Library/ColorSync/Profiles/."
            .into(),
    )
}

/// Convertit un PDF en CMYK selon Coated FOGRA39 via Ghostscript.
pub fn convert_to_fogra39(
    bytes: &[u8],
    icc_path: Option<&str>,
) -> Result<ColorConvertResult, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Le fichier n'est pas un PDF valide.".into());
    }
    let gs = find_ghostscript()?;
    let (profile, profile_label) = resolve_fogra39_profile(icc_path)?;

    let tmp = std::env::temp_dir().join(format!(
        "slate-color-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&tmp).map_err(|e| format!("Impossible de créer le dossier temporaire : {e}"))?;
    let input = tmp.join("input.pdf");
    let output = tmp.join("output.pdf");
    // Copie locale : avec -dSAFER, gs ne peut pas lire le profil Adobe hors sandbox.
    let local_icc = tmp.join("fogra39.icc");
    fs::copy(&profile, &local_icc)
        .map_err(|e| format!("Impossible de préparer le profil ICC : {e}"))?;
    fs::write(&input, bytes).map_err(|e| format!("Écriture PDF temporaire impossible : {e}"))?;

    let profile_str = local_icc
        .to_str()
        .ok_or_else(|| "Chemin ICC temporaire invalide.".to_string())?;
    let default_cmyk = format!("-sDefaultCMYKProfile={profile_str}");
    let output_icc = format!("-sOutputICCProfile={profile_str}");
    let output_file = format!("-sOutputFile={}", output.display());
    let input_str = input
        .to_str()
        .ok_or_else(|| "Chemin PDF temporaire invalide.".to_string())?
        .to_string();

    let status = Command::new(&gs)
        .arg("-dSAFER")
        .arg("-dBATCH")
        .arg("-dNOPAUSE")
        .arg("-dNOOUTERSAVE")
        .arg("-sDEVICE=pdfwrite")
        .arg("-dCompatibilityLevel=1.4")
        .arg("-sColorConversionStrategy=CMYK")
        .arg("-dProcessColorModel=/DeviceCMYK")
        .arg(&default_cmyk)
        .arg(&output_icc)
        .arg("-dRenderIntent=1") // Relative Colorimetric — proche prépresse
        .arg("-dOverrideICC=true")
        .arg("-dConvertCMYKImagesToRGB=false")
        .arg(&output_file)
        .arg(&input_str)
        .output()
        .map_err(|e| format!("Échec du lancement de Ghostscript : {e}"))?;

    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!(
            "Ghostscript a échoué (conversion FOGRA39).\n{}",
            stderr.chars().take(800).collect::<String>()
        ));
    }

    let out_bytes = fs::read(&output).map_err(|e| {
        let _ = fs::remove_dir_all(&tmp);
        format!("Lecture du PDF converti impossible : {e}")
    })?;
    let _ = fs::remove_dir_all(&tmp);

    if out_bytes.len() < 32 || !out_bytes.starts_with(b"%PDF-") {
        return Err("Ghostscript n'a pas produit un PDF valide.".into());
    }

    Ok(ColorConvertResult {
        bytes: out_bytes,
        profile_path: profile.display().to_string(),
        profile_label,
    })
}

/// Indique si le profil FOGRA39 est résolvable sur cette machine.
pub fn fogra39_profile_available() -> Option<String> {
    resolve_fogra39_profile(None)
        .ok()
        .map(|(path, label)| format!("{label} — {}", path.display()))
}

#[allow(dead_code)]
pub fn profile_exists(path: &Path) -> bool {
    path.is_file()
}
