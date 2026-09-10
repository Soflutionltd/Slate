//! Impression CUPS (`lp` / `lpstat` / `lpoptions`) — panneau Slate autonome.
//!
//! Remplace le passage par Aperçu / le seul sheet PDFKit pour l’impression
//! in-app. Objectif : contrôle explicite du format (`media=w4h6`) et de
//! l’échelle (`print-scaling=none` = taille réelle), critique pour les
//! étiquettes thermiques 4×6.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::print_layout::{
    fit_label_to_media, impose, Imposition, LabelTarget, Orientation, ScaleMode,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub display_name: String,
    pub is_default: bool,
    pub is_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSize {
    pub id: String,
    pub label: String,
    pub is_default: bool,
    /// Largeur en points PostScript (1/72"), si connue via le PPD.
    pub width_pts: Option<f64>,
    /// Hauteur en points PostScript, si connue via le PPD.
    pub height_pts: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterOptionChoice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// Un réglage exposé par le PPD de l’imprimante (qualité, bac, noirceur…).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterOption {
    /// Mot-clé CUPS, passé tel quel à `lp -o <keyword>=<choix>`.
    pub keyword: String,
    pub label: String,
    pub choices: Vec<PrinterOptionChoice>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOptions {
    pub printer: String,
    pub paper_size: Option<String>,
    /// Dimensions du media en points, remontées par `list_paper_sizes`.
    /// Présentes ⇒ on impose l’échelle nous-mêmes (voir `print_layout`).
    #[serde(default)]
    pub paper_width_pts: Option<f64>,
    #[serde(default)]
    pub paper_height_pts: Option<f64>,
    /// `actual` | `fit` | `fill` | `shrink` | `custom`
    pub scaling: String,
    pub custom_scale: Option<u32>,
    /// `auto` | `portrait` | `landscape`
    pub orientation: String,
    pub copies: u32,
    /// Ex. `1-3,5` — syntaxe CUPS `-P`.
    pub page_range: Option<String>,
    #[serde(default)]
    pub grayscale: bool,
    #[serde(default)]
    pub duplex: bool,
    #[serde(default)]
    pub reverse: bool,
    /// Réglages PPD choisis dans « Options avancées » (`keyword` → `choix`).
    #[serde(default)]
    pub extra_options: Vec<(String, String)>,
    /// Recadre l’étiquette sur son contenu avant l’envoi. Prend le pas sur
    /// `scaling` : l’ajustement est alors déjà fait, à l’unité près.
    #[serde(default)]
    pub fit_to_label: bool,
    /// Bandes vides internes ramenées à cette hauteur, en points. 0 = simple
    /// recadrage sur la bounding box.
    #[serde(default)]
    pub label_gutter_pt: f64,
    /// Marge blanche conservée autour de l’étiquette recadrée.
    #[serde(default)]
    pub label_margin_pt: f64,
}

fn run_capture(bin: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Impossible d’exécuter {bin} : {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(if detail.is_empty() {
            format!("{bin} a échoué (code {:?}).", output.status.code())
        } else {
            format!("{bin} : {detail}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Extrait `key='value with spaces'` ou `key=token` depuis la sortie `lpoptions`.
pub fn extract_lp_option(hay: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let idx = hay.find(&needle)?;
    let after = &hay[idx + needle.len()..];
    if let Some(rest) = after.strip_prefix('\'') {
        let end = rest.find('\'')?;
        return Some(rest[..end].to_string());
    }
    if let Some(rest) = after.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    Some(after.split_whitespace().next()?.to_string())
}

/// Parse une ligne `PageSize/…: *id other …` issue de `lpoptions -l`.
pub fn parse_pagesize_line(line: &str) -> Vec<(String, bool)> {
    let trimmed = line.trim();
    if !trimmed.starts_with("PageSize/") {
        return Vec::new();
    }
    let Some(colon) = trimmed.find(':') else {
        return Vec::new();
    };
    let values = trimmed[colon + 1..].trim();
    let mut out = Vec::new();
    for token in values.split_whitespace() {
        let is_default = token.starts_with('*');
        let id = token.trim_start_matches('*');
        if id.is_empty() || id.eq_ignore_ascii_case("Custom.WIDTHxHEIGHT") {
            continue;
        }
        out.push((id.to_string(), is_default));
    }
    out
}

/// Mots-clés déjà pilotés par le panneau : les exposer une seconde fois dans
/// « Options avancées » enverrait deux `-o` contradictoires à `lp`.
const RESERVED_OPTION_KEYWORDS: &[&str] = &[
    "PageSize",
    "PageRegion",
    "Duplex",
    "ColorModel",
    "Collate",
    "Copies",
    "OutputOrder",
];

/// Parse une ligne générique `Keyword/Libellé: a *b c` de `lpoptions -l`.
pub fn parse_option_line(line: &str) -> Option<(String, String, Vec<(String, bool)>)> {
    let trimmed = line.trim();
    let colon = trimmed.find(':')?;
    let (head, tail) = trimmed.split_at(colon);
    let (keyword, label) = match head.split_once('/') {
        Some((keyword, label)) => (keyword.trim(), label.trim()),
        None => (head.trim(), head.trim()),
    };
    // Un mot-clé CUPS est un seul token ; une ligne d’état de `lpstat` mal
    // aiguillée ici en contiendrait plusieurs.
    if keyword.is_empty() || keyword.chars().any(char::is_whitespace) {
        return None;
    }
    let mut choices = Vec::new();
    for token in tail[1..].split_whitespace() {
        let is_default = token.starts_with('*');
        let id = token.trim_start_matches('*');
        if id.is_empty() || id.eq_ignore_ascii_case("Custom.WIDTHxHEIGHT") {
            continue;
        }
        choices.push((id.to_string(), is_default));
    }
    if choices.is_empty() {
        return None;
    }
    Some((
        keyword.to_string(),
        if label.is_empty() {
            keyword.to_string()
        } else {
            label.to_string()
        },
        choices,
    ))
}

/// Libellés lisibles des choix, depuis les `*Keyword Choix/Libellé: "…"` du PPD.
pub fn parse_ppd_choice_labels(ppd: &str) -> HashMap<(String, String), String> {
    let mut map = HashMap::new();
    for line in ppd.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('*') else {
            continue;
        };
        let Some((head, _)) = rest.split_once(':') else {
            continue;
        };
        let Some((keyword, remainder)) = head.split_once(' ') else {
            continue;
        };
        let Some((choice, label)) = remainder.split_once('/') else {
            continue;
        };
        let (keyword, choice, label) = (keyword.trim(), choice.trim(), label.trim());
        if keyword.is_empty() || choice.is_empty() || label.is_empty() {
            continue;
        }
        map.insert((keyword.to_string(), choice.to_string()), label.to_string());
    }
    map
}

/// Réglages PPD de l’imprimante, hors ceux déjà pilotés par le panneau.
pub fn list_printer_options(printer: &str) -> Result<Vec<PrinterOption>, String> {
    if printer.trim().is_empty() {
        return Err("Nom d’imprimante manquant.".into());
    }
    let listing = run_capture("lpoptions", &["-p", printer, "-l"])?;
    let labels = fs::read_to_string(ppd_path_for(printer))
        .ok()
        .map(|ppd| parse_ppd_choice_labels(&ppd))
        .unwrap_or_default();

    let mut options = Vec::new();
    for line in listing.lines() {
        let Some((keyword, label, choices)) = parse_option_line(line) else {
            continue;
        };
        if RESERVED_OPTION_KEYWORDS
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(&keyword))
        {
            continue;
        }
        // Un réglage à choix unique n’offre aucune décision à l’utilisateur.
        if choices.len() < 2 {
            continue;
        }
        options.push(PrinterOption {
            choices: choices
                .into_iter()
                .map(|(id, is_default)| PrinterOptionChoice {
                    label: labels
                        .get(&(keyword.clone(), id.clone()))
                        .cloned()
                        .unwrap_or_else(|| id.clone()),
                    id,
                    is_default,
                })
                .collect(),
            keyword,
            label,
        });
    }
    Ok(options)
}

/// Parse les `*PaperDimension id/label: "W H"` (et labels `*PageSize`) d’un PPD.
pub fn parse_ppd_paper_meta(ppd: &str) -> HashMap<String, (Option<f64>, Option<f64>, String)> {
    let mut map: HashMap<String, (Option<f64>, Option<f64>, String)> = HashMap::new();

    for line in ppd.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("*PageSize ") {
            // *PageSize w4h6/4 x 6 (4.00 in x 6.00 in): "..."
            if let Some((head, _)) = rest.split_once(':') {
                if let Some((id, label)) = head.split_once('/') {
                    let entry = map.entry(id.trim().to_string()).or_insert((None, None, id.trim().to_string()));
                    if !label.trim().is_empty() {
                        entry.2 = label.trim().to_string();
                    }
                }
            }
        }
        if let Some(rest) = line.strip_prefix("*PaperDimension ") {
            // *PaperDimension w4h6/4 x 6 (...): "288 432"
            let Some((head, dims_part)) = rest.split_once(':') else {
                continue;
            };
            let (id, label) = match head.split_once('/') {
                Some((i, l)) => (i.trim(), l.trim()),
                None => (head.trim(), head.trim()),
            };
            let dims = dims_part.trim().trim_matches('"');
            let mut parts = dims.split_whitespace();
            let w = parts.next().and_then(|s| s.parse::<f64>().ok());
            let h = parts.next().and_then(|s| s.parse::<f64>().ok());
            let entry = map
                .entry(id.to_string())
                .or_insert((None, None, id.to_string()));
            entry.0 = w;
            entry.1 = h;
            if !label.is_empty() {
                entry.2 = label.to_string();
            }
        }
    }
    map
}

fn default_printer_name() -> Option<String> {
    let text = run_capture("lpstat", &["-d"]).ok()?;
    // "system default destination: NAME" / "destination système par défaut : NAME"
    for line in text.lines() {
        if let Some(idx) = line.rfind(':') {
            let name = line[idx + 1..].trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn printer_ready_set() -> std::collections::HashSet<String> {
    let mut ready = std::collections::HashSet::new();
    // `lpstat -p` liste les queues ; « inactive » / « idle » / « printing » = ready.
    // « disabled » = not ready. On marque ready sauf si disabled clairement.
    if let Ok(text) = run_capture("lpstat", &["-p"]) {
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            // Formats : "printer NAME is idle..." / "l’imprimante NAME est inactive..."
            let name = if let Some(rest) = line.strip_prefix("printer ") {
                rest.split_whitespace().next()
            } else if let Some(idx) = lower.find("imprimante ") {
                line[idx + "imprimante ".len()..]
                    .split_whitespace()
                    .next()
            } else {
                None
            };
            let Some(name) = name else { continue };
            let disabled = lower.contains("disabled") || lower.contains("désactivée") || lower.contains("desactivee");
            if !disabled {
                ready.insert(name.to_string());
            }
        }
    }
    ready
}

fn printer_display_name(name: &str) -> String {
    if let Ok(text) = run_capture("lpoptions", &["-p", name]) {
        if let Some(info) = extract_lp_option(&text, "printer-info") {
            let trimmed = info.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(model) = extract_lp_option(&text, "printer-make-and-model") {
            let trimmed = model.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    name.replace('_', " ")
}

fn ppd_path_for(printer: &str) -> PathBuf {
    // macOS : /private/etc/cups/ppd — Linux : /etc/cups/ppd
    let mac = PathBuf::from(format!("/private/etc/cups/ppd/{printer}.ppd"));
    if mac.is_file() {
        return mac;
    }
    PathBuf::from(format!("/etc/cups/ppd/{printer}.ppd"))
}

/// Liste les imprimantes CUPS.
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    let names_raw = run_capture("lpstat", &["-e"]).map_err(|e| {
        format!(
            "Aucune imprimante détectée ({e}). Vérifie CUPS / Préférences Système → Imprimantes."
        )
    })?;
    let default = default_printer_name();
    let ready = printer_ready_set();
    let mut printers = Vec::new();
    for name in names_raw.lines().map(str::trim).filter(|s| !s.is_empty()) {
        printers.push(PrinterInfo {
            display_name: printer_display_name(name),
            is_default: default.as_deref() == Some(name),
            is_ready: ready.is_empty() || ready.contains(name),
            name: name.to_string(),
        });
    }
    if printers.is_empty() {
        return Err("Aucune imprimante installée.".into());
    }
    // Défaut en tête pour l’UX.
    printers.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.display_name.cmp(&b.display_name)));
    Ok(printers)
}

/// Formats de papier exposés par l’imprimante (lpoptions + PPD).
pub fn list_paper_sizes(printer: &str) -> Result<Vec<PaperSize>, String> {
    if printer.trim().is_empty() {
        return Err("Nom d’imprimante manquant.".into());
    }
    let options = run_capture("lpoptions", &["-p", printer, "-l"])?;
    let mut ids: Vec<(String, bool)> = Vec::new();
    for line in options.lines() {
        let parsed = parse_pagesize_line(line);
        if !parsed.is_empty() {
            ids = parsed;
            break;
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let meta = fs::read_to_string(ppd_path_for(printer))
        .ok()
        .map(|s| parse_ppd_paper_meta(&s))
        .unwrap_or_default();

    Ok(ids
        .into_iter()
        .map(|(id, is_default)| {
            let (width_pts, height_pts, label) = meta
                .get(&id)
                .cloned()
                .unwrap_or((None, None, id.clone()));
            PaperSize {
                id,
                label,
                is_default,
                width_pts,
                height_pts,
            }
        })
        .collect())
}

fn scaling_args(scaling: &str, custom_scale: Option<u32>) -> Result<Vec<String>, String> {
    match scaling {
        "actual" | "none" => Ok(vec!["-o".into(), "print-scaling=none".into()]),
        "fit" | "shrink" => Ok(vec!["-o".into(), "print-scaling=fit".into()]),
        "fill" => Ok(vec!["-o".into(), "print-scaling=fill".into()]),
        "custom" => {
            let pct = custom_scale.unwrap_or(100).clamp(1, 400);
            Ok(vec!["-o".into(), format!("scaling={pct}")])
        }
        other => Err(format!("Mode d’échelle inconnu : {other}")),
    }
}

/// Un identifiant PPD : lettres, chiffres et `. _ - :` (ex. `com.brother-bp71`,
/// `203dpi`, `-10`).
fn is_ppd_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

fn scale_mode_from(scaling: &str, custom_scale: Option<u32>) -> Result<ScaleMode, String> {
    match scaling {
        "actual" | "none" => Ok(ScaleMode::Actual),
        "fit" => Ok(ScaleMode::Fit),
        "fill" => Ok(ScaleMode::Fill),
        "shrink" => Ok(ScaleMode::Shrink),
        "custom" => Ok(ScaleMode::Custom(
            custom_scale.unwrap_or(100).clamp(1, 400) as f64
        )),
        other => Err(format!("Mode d’échelle inconnu : {other}")),
    }
}

fn orientation_from(orientation: &str) -> Result<Orientation, String> {
    match orientation {
        "auto" | "" => Ok(Orientation::Auto),
        "portrait" => Ok(Orientation::Portrait),
        "landscape" => Ok(Orientation::Landscape),
        other => Err(format!("Orientation inconnue : {other}")),
    }
}

/// Envoie le PDF à CUPS avec les options du panneau Slate.
pub fn print_pdf_with_options(bytes: &[u8], options: &PrintOptions) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Le contenu à imprimer n’est pas un PDF valide.".into());
    }
    if options.printer.trim().is_empty() {
        return Err("Choisis une imprimante.".into());
    }
    let copies = options.copies.max(1).min(999);
    let mode = scale_mode_from(&options.scaling, options.custom_scale)?;
    let orientation = orientation_from(&options.orientation)?;

    // macOS n’embarque pas le filtre `pdftopdf` de cups-filters : sa chaîne
    // (`cgpdftoraster`) ignore `print-scaling` sans le signaler, et le driver
    // ancre puis rogne à sa façon. Dès qu’on connaît les dimensions du media,
    // on impose donc l’échelle dans le PDF lui-même — le driver n’a plus rien
    // à décider et la sortie correspond à l’aperçu.
    let sheet = match (options.paper_width_pts, options.paper_height_pts) {
        (Some(w), Some(h)) if w > 1.0 && h > 1.0 => Some((w, h)),
        _ => None,
    };
    let mut imposed = false;
    let payload: Vec<u8> = match sheet {
        Some((sheet_width_pts, sheet_height_pts)) if options.fit_to_label => {
            // Recadrage d’étiquette : la page produite fait déjà exactement la
            // taille du media, contenu ajusté au plus grand. Toute imposition
            // supplémentaire ne pourrait que rétrécir le résultat.
            let target = LabelTarget {
                width_pt: sheet_width_pts,
                height_pt: sheet_height_pts,
                margin_pt: options.label_margin_pt.max(0.0),
                gutter_pt: options.label_gutter_pt.max(0.0),
            };
            let fitted = fit_label_to_media(bytes, &target)?;
            imposed = true;
            fitted.bytes
        }
        Some((sheet_width_pts, sheet_height_pts)) => {
            let settings = Imposition {
                sheet_width_pts,
                sheet_height_pts,
                mode,
                orientation,
            };
            match impose(bytes, &settings) {
                Ok(out) => {
                    imposed = true;
                    out
                }
                Err(error) => {
                    // Un PDF que lopdf refuse ne doit pas rendre l’impression
                    // impossible : on retombe sur les options CUPS brutes, en
                    // laissant la trace pour le diagnostic.
                    eprintln!("[print] imposition impossible, repli sur CUPS : {error}");
                    bytes.to_vec()
                }
            }
        }
        None => bytes.to_vec(),
    };

    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    path.push(format!("slate-print-{stamp}.pdf"));
    fs::write(&path, &payload)
        .map_err(|e| format!("Écriture du fichier d’impression impossible : {e}"))?;

    let mut args: Vec<String> = vec![
        "-d".into(),
        options.printer.clone(),
        "-n".into(),
        copies.to_string(),
    ];
    if !imposed {
        // Sans imposition, on laisse CUPS tenter l’orientation et l’échelle.
        match orientation {
            Orientation::Portrait => {
                args.push("-o".into());
                args.push("orientation-requested=3".into());
            }
            Orientation::Landscape => {
                args.push("-o".into());
                args.push("orientation-requested=4".into());
            }
            Orientation::Auto => {}
        }
    }
    if let Some(media) = options.paper_size.as_deref().filter(|s| !s.is_empty()) {
        args.push("-o".into());
        args.push(format!("media={media}"));
    }
    if imposed {
        // Les pages font déjà la taille du media : toute mise à l’échelle
        // supplémentaire du driver ne ferait que réintroduire le décalage.
        args.push("-o".into());
        args.push("print-scaling=none".into());
    } else {
        args.append(&mut scaling_args(&options.scaling, options.custom_scale)?);
    }
    if options.grayscale {
        args.push("-o".into());
        args.push("print-color-mode=monochrome".into());
        args.push("-o".into());
        args.push("ColorModel=Gray".into());
    }
    if options.duplex {
        args.push("-o".into());
        args.push("sides=two-sided-long-edge".into());
    }
    if options.reverse {
        args.push("-o".into());
        args.push("outputorder=reverse".into());
    }
    for (keyword, choice) in &options.extra_options {
        // Les mots-clés et choix PPD sont des identifiants : tout le reste est
        // rejeté plutôt que transmis à `lp` en espérant que ça passe.
        if !is_ppd_token(keyword) || !is_ppd_token(choice) {
            let _ = fs::remove_file(&path);
            return Err(format!("Réglage d’imprimante invalide : {keyword}={choice}"));
        }
        if RESERVED_OPTION_KEYWORDS
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(keyword))
        {
            continue;
        }
        args.push("-o".into());
        args.push(format!("{keyword}={choice}"));
    }
    if let Some(range) = options
        .page_range
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Garde-fou basique : chiffres, tirets, virgules, espaces.
        if !range
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == ',' || c.is_whitespace())
        {
            let _ = fs::remove_file(&path);
            return Err("Plage de pages invalide (ex. 1-3,5).".into());
        }
        args.push("-P".into());
        args.push(range.replace(' ', ""));
    }
    args.push(path.to_string_lossy().to_string());

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_capture("lp", &arg_refs);
    let _ = fs::remove_file(&path);
    result.map(|_| ())
}

#[allow(dead_code)]
pub fn ppd_exists(printer: &str) -> bool {
    Path::new(&ppd_path_for(printer)).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pagesize_marks_default_and_skips_custom() {
        let line = "PageSize/Page Size: Custom.WIDTHxHEIGHT w2h4 w4h4 *w4h6 LB10";
        let parsed = parse_pagesize_line(line);
        assert_eq!(
            parsed,
            vec![
                ("w2h4".into(), false),
                ("w4h4".into(), false),
                ("w4h6".into(), true),
                ("LB10".into(), false),
            ]
        );
    }

    #[test]
    fn parse_pagesize_brother_a4_default() {
        let line = "PageSize/Media Size: 4x6 A3 *A4 Letter Custom.WIDTHxHEIGHT";
        let parsed = parse_pagesize_line(line);
        assert!(parsed.iter().any(|(id, def)| id == "A4" && *def));
        assert!(!parsed.iter().any(|(id, _)| id.contains("Custom")));
    }

    #[test]
    fn parse_ppd_dimensions_and_labels() {
        let ppd = r#"
*PageSize w4h6/4 x 6 (4.00 in x 6.00 in): "<</PageSize[288 432]>>setpagedevice"
*PaperDimension w4h6/4 x 6 (4.00 in x 6.00 in): "288 432"
*PaperDimension A4/A4: "595.28 841.89"
"#;
        let meta = parse_ppd_paper_meta(ppd);
        let (w, h, label) = meta.get("w4h6").expect("w4h6");
        assert_eq!(*w, Some(288.0));
        assert_eq!(*h, Some(432.0));
        assert!(label.contains("4 x 6"));
        let (aw, ah, _) = meta.get("A4").expect("A4");
        assert_eq!(*aw, Some(595.28));
        assert_eq!(*ah, Some(841.89));
    }

    #[test]
    fn parse_option_line_reads_keyword_label_and_choices() {
        let (keyword, label, choices) =
            parse_option_line("PostAction/Post-Print Action: Normal None *TearOff Cut")
                .expect("ligne d’option");
        assert_eq!(keyword, "PostAction");
        assert_eq!(label, "Post-Print Action");
        assert_eq!(
            choices,
            vec![
                ("Normal".to_string(), false),
                ("None".to_string(), false),
                ("TearOff".to_string(), true),
                ("Cut".to_string(), false),
            ]
        );
    }

    #[test]
    fn parse_option_line_handles_negative_and_dotted_choices() {
        let (keyword, _, choices) =
            parse_option_line("Brightness/Brightness: 10 *0 -10 -20").expect("ligne");
        assert_eq!(keyword, "Brightness");
        assert!(choices.iter().any(|(id, def)| id == "0" && *def));
        assert!(choices.iter().any(|(id, _)| id == "-20"));

        let (_, _, media) =
            parse_option_line("MediaType/MediaType: stationery com.brother-bp71 *any")
                .expect("ligne");
        assert!(media.iter().any(|(id, _)| id == "com.brother-bp71"));
    }

    #[test]
    fn parse_option_line_rejects_status_lines() {
        // `lpstat -p` mélangé par erreur : le mot-clé contiendrait des espaces.
        assert!(parse_option_line("printer SN-420B is idle: enabled").is_none());
        // Aucune valeur après le deux-points.
        assert!(parse_option_line("Resolution/Resolution:").is_none());
    }

    #[test]
    fn parse_ppd_choice_labels_maps_readable_names() {
        let ppd = r#"
*OpenUI *Darkness/Noirceur: PickOne
*Darkness 8/8 (normal): "<</cupsCompression 8>>setpagedevice"
*PostAction TearOff/Découpe manuelle: "..."
*CloseUI: *Darkness
"#;
        let labels = parse_ppd_choice_labels(ppd);
        assert_eq!(
            labels.get(&("Darkness".to_string(), "8".to_string())).map(String::as_str),
            Some("8 (normal)")
        );
        assert_eq!(
            labels
                .get(&("PostAction".to_string(), "TearOff".to_string()))
                .map(String::as_str),
            Some("Découpe manuelle")
        );
    }

    #[test]
    fn ppd_token_accepts_real_choices_and_rejects_injection() {
        for good in ["TearOff", "com.brother-bp71", "203dpi", "-10", "two-sided:long"] {
            assert!(is_ppd_token(good), "refusé à tort : {good}");
        }
        for bad in ["", "a b", "a;b", "a$(id)", "a/b", "a=b"] {
            assert!(!is_ppd_token(bad), "accepté à tort : {bad}");
        }
    }

    #[test]
    fn extract_quoted_printer_info() {
        let hay = "copies=1 printer-info='Brother MFC-J6955DW' printer-make-and-model='Brother Inkjet'";
        assert_eq!(
            extract_lp_option(hay, "printer-info").as_deref(),
            Some("Brother MFC-J6955DW")
        );
        assert_eq!(
            extract_lp_option(hay, "printer-make-and-model").as_deref(),
            Some("Brother Inkjet")
        );
    }
}
