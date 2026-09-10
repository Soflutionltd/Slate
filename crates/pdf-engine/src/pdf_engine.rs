use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

// PDFium ne peut être lié qu'UNE seule fois par process (BINDINGS global dans
// pdfium-render). On garde donc une instance unique partagée, protégée par un
// Mutex (PDFium n'est pas thread-safe).
static PDFIUM: OnceLock<Option<Mutex<Pdfium>>> = OnceLock::new();

#[cfg(target_arch = "wasm32")]
fn create_pdfium() -> Option<Pdfium> {
    // Le module Pdfium WASM doit être initialisé côté JS (`initialize_pdfium_render`)
    // avant le premier appel. Pdfium::default() lie le module déjà chargé.
    Some(Pdfium::default())
}

#[cfg(not(target_arch = "wasm32"))]
fn create_pdfium() -> Option<Pdfium> {
    for dir in pdfium_search_dirs() {
        let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
        if lib.exists() {
            if let Ok(bindings) = Pdfium::bind_to_library(&lib) {
                return Some(Pdfium::new(bindings));
            }
        }
    }
    Pdfium::bind_to_system_library().map(Pdfium::new).ok()
}

/// Verrouille l'instance PDFium partagée (liée une seule fois, à la demande).
pub fn pdfium_guard() -> Result<MutexGuard<'static, Pdfium>, String> {
    let cell = PDFIUM.get_or_init(|| create_pdfium().map(Mutex::new));
    let mtx = cell
        .as_ref()
        .ok_or_else(|| "PDFium library unavailable".to_string())?;
    mtx.lock().map_err(|e| e.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn pdfium_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("../Resources"));
            dirs.push(dir.join("../Frameworks"));
        }
    }
    // Chemin explicite (tests, déploiements sur mesure).
    if let Ok(custom) = std::env::var("ALTO_PDFIUM_DIR") {
        if !custom.is_empty() {
            dirs.push(PathBuf::from(custom));
        }
    }
    // Racine du crate : la dylib y est présente en dev/CI (libpdfium.dylib).
    // En production ce chemin n'existe pas sur la machine de l'utilisateur, il est
    // donc simplement ignoré (les dossiers près de l'exécutable priment).
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    dirs
}

#[derive(Debug, Serialize)]
pub struct PdfAnalysis {
    pub page: u32,
    #[serde(rename = "pageWidth")]
    pub page_width: f64,
    #[serde(rename = "pageHeight")]
    pub page_height: f64,
    pub blocks: Vec<PdfEditBlock>,
    pub engine: String,
}

#[derive(Debug, Serialize)]
pub struct PdfEditBlock {
    pub id: String,
    pub kind: String,
    pub page: u32,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(rename = "fontSize")]
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub serif: bool,
    #[serde(rename = "fontName")]
    pub font_name: String,
    pub justified: bool,
    pub chars: Vec<PdfCharBox>,
    pub source: String,
    pub confidence: f64,
    #[serde(rename = "fieldKind")]
    pub field_kind: Option<String>,
    pub critical: bool,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfCharBox {
    pub text: String,
    // Boîte LARGE (loose bounds) : hauteur de ligne uniforme, inclut l'avance des
    // espaces => fiable pour le hit-test du caret et le regroupement en lignes.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    // Boîte SERRÉE (tight bounds) : épouse le glyphe => utilisée pour masquer un
    // caractère supprimé sans mordre sur ses voisins.
    #[serde(rename = "maskX")]
    pub mask_x: f64,
    #[serde(rename = "maskY")]
    pub mask_y: f64,
    #[serde(rename = "maskWidth")]
    pub mask_width: f64,
    #[serde(rename = "maskHeight")]
    pub mask_height: f64,
    // Index du caractère dans la PAGE TEXTE PDFium (FPDF_TEXTPAGE). C'est la clé
    // qui permet l'ÉDITION NATIVE : retrouver l'objet texte propriétaire du
    // caractère et y splicer la modification. -1 si inconnu (OCR, fallback).
    #[serde(rename = "pageCharIndex")]
    pub page_char_index: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlattenedPage {
    pub jpeg_bytes: Vec<u8>,
    pub width: f64,
    pub height: f64,
}

/// Page de l'export hybride. `jpeg_bytes` vide ⇒ la page est conservée TELLE
/// QUELLE dans le document d'origine (texte/vecteurs natifs préservés). Non
/// vide ⇒ la page a été éditée : son contenu est remplacé par l'image aplatie.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedPage {
    pub page_number: u32,
    pub jpeg_bytes: Vec<u8>,
    pub width: f64,
    pub height: f64,
    pub strategy: Option<ExportStrategy>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportStrategy {
    pub page_number: u32,
    pub mode: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorTextOperation {
    pub page_number: u32,
    pub bbox: [f64; 4],
    pub target_bbox: Option<[f64; 4]>,
    pub text: String,
    pub font: Option<String>,
    /// Famille réelle demandée (police d'origine ou choix du sélecteur). Résolue
    /// en octets `font_bytes` côté application (font_kit) avant l'export.
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    /// Octets de la police à embarquer. Jamais envoyé par le JS : rempli par la
    /// couche Tauri à partir de `font_family`.
    #[serde(default, skip)]
    pub font_bytes: Option<Vec<u8>>,
    pub size: Option<f64>,
    pub color: Option<[u8; 3]>,
    pub align: Option<String>,
    pub source: Option<String>,
    #[serde(default)]
    pub insert_only: bool,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorExportResult {
    pub bytes: Vec<u8>,
    pub applied: usize,
    pub warnings: Vec<String>,
}

fn should_flatten_edited_page(page: &EditedPage) -> bool {
    if page.jpeg_bytes.is_empty() {
        return false;
    }
    match page.strategy.as_ref().map(|strategy| strategy.mode.as_str()) {
        // Réservé au prochain niveau : une page candidate vectorielle peut être
        // traitée nativement quand les opérations détaillées sont fournies. Tant
        // qu'elles ne le sont pas, on garde le fallback aplati pour fidélité.
        Some("vector_candidate") | Some("flatten_page") | None => true,
        Some("native_preserved") => false,
        Some(_) => true,
    }
}

#[derive(Debug, Clone)]
struct TextSegment {
    text: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    font_size: f64,
    bold: bool,
    italic: bool,
    serif: bool,
    font_name: String,
    justified: bool,
    chars: Vec<PdfCharBox>,
}

fn should_insert_visual_space(previous: &TextSegment, current: &TextSegment) -> bool {
    should_insert_visual_space_between(
        previous,
        current,
        previous.x + previous.width,
        current.x,
    )
}

/// Variante à géométrie explicite : `prev_right` / `cur_left` sont les bords
/// réels entre lesquels l'écart est mesuré. Les boîtes de SEGMENTS PDFium
/// peuvent être plus larges que leurs caractères (ex : un mot coupé en deux
/// show-ops « Sof » + « lution » annonçait un écart de 3 pt alors que les
/// glyphes sont jointifs) — mesurer sur les caractères évite d'inventer un
/// espace au milieu d'un mot.
fn should_insert_visual_space_between(
    previous: &TextSegment,
    current: &TextSegment,
    prev_right: f64,
    cur_left: f64,
) -> bool {
    let gap = cur_left - prev_right;
    if gap <= 0.0 {
        return false;
    }

    let ref_size = previous
        .font_size
        .max(current.font_size)
        .max(previous.height.max(current.height))
        .max(1.0);
    if gap <= (ref_size * 0.22).max(1.5) {
        return false;
    }

    let prev_last = previous.text.chars().rev().find(|c| !c.is_whitespace());
    let current_first = current.text.chars().find(|c| !c.is_whitespace());
    match (prev_last, current_first) {
        (_, Some(c)) if ".,;:!?)]}%".contains(c) => false,
        (Some(c), _) if "([{".contains(c) => false,
        _ => true,
    }
}

/// Fusionne les caractères d'un groupe de segments d'une même ligne visuelle
/// et reconstruit le texte DEPUIS les caractères fusionnés : l'alignement
/// texte ↔ glyphes est ainsi garanti PAR CONSTRUCTION (c'est la condition de
/// l'édition native et du caret dessiné côté interface).
///
/// Deux pièges traités à la source :
/// - Segments qui se CHEVAUCHENT (typique après une insertion native : le
///   nouvel objet texte recouvre l'ancien) : PDFium restitue les caractères
///   frontière dans les deux segments → dédoublonnage par index de page.
/// - Espace « visuel » entre deux segments séparés par un blanc : boîte
///   SYNTHÉTIQUE posée dans le blanc (page_char_index = -1 : aucun caractère
///   réel dans la page), sinon le texte porterait un espace de plus que les
///   glyphes.
fn merge_segment_texts_and_chars(group: &[TextSegment]) -> (String, Vec<PdfCharBox>) {
    // Garde : un segment SANS boîtes de caractères (extraction PDFium en échec,
    // contenu protégé…) rendrait le texte reconstruit incomplet. On retombe
    // alors sur l'ancienne jonction de textes : le bloc s'affiche intact, il
    // est simplement inéligible à l'édition native (pas de glyphes fiables).
    if group
        .iter()
        .any(|s| !s.text.trim().is_empty() && s.chars.is_empty())
    {
        let mut merged = String::new();
        let mut previous: Option<&TextSegment> = None;
        for segment in group {
            let text = segment.text.trim();
            if text.is_empty() {
                continue;
            }
            if let Some(prev) = previous {
                if should_insert_visual_space(prev, segment) && !merged.ends_with(' ') {
                    merged.push(' ');
                }
            }
            merged.push_str(text);
            previous = Some(segment);
        }
        let chars = group
            .iter()
            .flat_map(|s| s.chars.iter().cloned())
            .collect();
        return (merged, chars);
    }

    let mut chars: Vec<PdfCharBox> = Vec::new();
    let mut previous: Option<&TextSegment> = None;

    for segment in group {
        if segment.text.trim().is_empty() || segment.chars.is_empty() {
            continue;
        }
        if let Some(prev) = previous {
            let last_is_ws = chars
                .last()
                .map(|c| c.text.chars().all(char::is_whitespace))
                .unwrap_or(true);
            let next_starts_ws = segment
                .chars
                .first()
                .map(|c| c.text.chars().all(char::is_whitespace))
                .unwrap_or(false);
            // Écart mesuré sur les CARACTÈRES, pas sur les boîtes de segments
            // (souvent plus larges que leurs glyphes) : « Sof »+« lution »
            // scindé en deux show-ops jointifs ne doit pas gagner d'espace.
            let prev_right = chars
                .iter()
                .rev()
                .find(|c| !c.text.chars().all(char::is_whitespace))
                .map(|c| c.x + c.width)
                .unwrap_or(prev.x + prev.width);
            let cur_left = segment
                .chars
                .iter()
                .find(|c| !c.text.chars().all(char::is_whitespace))
                .map(|c| c.x)
                .unwrap_or(segment.x);
            if should_insert_visual_space_between(prev, segment, prev_right, cur_left)
                && !last_is_ws
                && !next_starts_ws
            {
                // should_insert_visual_space_between garantit gap > 0.
                let left = prev_right;
                let right = cur_left;
                let y = prev.y.min(segment.y);
                let bottom = (prev.y + prev.height).max(segment.y + segment.height);
                chars.push(PdfCharBox {
                    text: " ".to_string(),
                    x: left,
                    y,
                    width: (right - left).max(0.1),
                    height: (bottom - y).max(0.1),
                    mask_x: left,
                    mask_y: y,
                    mask_width: (right - left).max(0.1),
                    mask_height: (bottom - y).max(0.1),
                    page_char_index: -1,
                });
            }
        }
        chars.extend(segment.chars.iter().cloned());
        previous = Some(segment);
    }

    // Dédoublonnage par index de page : un caractère du document n'existe
    // qu'une fois, même si deux segments superposés le restituent chacun.
    let mut seen = std::collections::BTreeSet::new();
    chars.retain(|c| c.page_char_index < 0 || seen.insert(c.page_char_index));

    // Ordre de LECTURE : le groupe est une ligne visuelle unique → tri par x
    // (départage stable par index de page).
    chars.sort_by(|a, b| {
        a.x.partial_cmp(&b.x)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.page_char_index.cmp(&b.page_char_index))
    });

    // Blancs d'extrémité retirés (le texte des blocs a toujours été trimé).
    while chars
        .first()
        .is_some_and(|c| c.text.chars().all(char::is_whitespace))
    {
        chars.remove(0);
    }
    while chars
        .last()
        .is_some_and(|c| c.text.chars().all(char::is_whitespace))
    {
        chars.pop();
    }

    let merged: String = chars.iter().map(|c| c.text.as_str()).collect();
    (merged, chars)
}

// Caractères d'un paragraphe : simple concaténation des lignes, DÉJÀ triées
// en ordre de lecture par merge_segment_texts_and_chars. Un re-tri global par
// (y, x) déplaçait les glyphes de hauteur atypique (ex : caractère écrit en
// police de secours) au milieu du tableau, désalignant l'ordre tableau ↔ texte.
fn merge_segment_chars(group: &[TextSegment]) -> Vec<PdfCharBox> {
    group
        .iter()
        .flat_map(|segment| segment.chars.iter().cloned())
        .collect()
}

fn normalize_doc_text(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ý' | 'ÿ' => 'y',
            _ => c,
        })
        .collect::<String>()
        .to_lowercase()
}

fn score_terms(text: &str, terms: &[&str]) -> u32 {
    terms.iter().filter(|term| text.contains(**term)).count() as u32
}

fn classify_document_text(text: &str) -> (&'static str, f64) {
    let normalized = normalize_doc_text(text);
    let invoice = score_terms(
        &normalized,
        &["facture", "invoice", "total ht", "total ttc", "tva", "siret", "siren"],
    );
    let credit = score_terms(&normalized, &["avoir", "credit note", "note de credit"])
        + u32::from(invoice > 0);
    let receipt = score_terms(&normalized, &["recu", "ticket", "receipt", "paiement recu"]);
    let quote = score_terms(&normalized, &["devis", "quote", "bon pour accord"]);
    let contract = score_terms(&normalized, &["contrat", "contract", "conditions generales", "signature"]);
    let statement = score_terms(&normalized, &["releve", "statement", "solde", "iban", "bic"]);
    let mut candidates = [
        ("credit_note", credit),
        ("invoice", invoice),
        ("receipt", receipt),
        ("quote", quote),
        ("contract", contract),
        ("statement", statement),
    ];
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    let (kind, score) = candidates[0];
    if score >= 2 {
        (kind, (score as f64 * 18.0).min(100.0))
    } else {
        ("other", 0.0)
    }
}

fn detect_field_kind(text: &str, document_type: &str) -> Option<&'static str> {
    let normalized = normalize_doc_text(text);
    let upper = text.to_ascii_uppercase();
    let digits = text.chars().filter(|c| c.is_ascii_digit()).count();
    if upper.contains("IBAN") || upper.contains("FR") && digits >= 20 {
        return Some("iban");
    }
    if upper.contains("TVA") && upper.contains("FR") {
        return Some("vat_id");
    }
    if normalized.contains("siret") || normalized.contains("siren") || digits == 9 || digits == 14 {
        return Some("company_id");
    }
    if normalized.contains("tva") || normalized.contains("vat") {
        return Some("tax");
    }
    if normalized.contains("total") || normalized.contains("ttc") || normalized.contains("net a payer") {
        return Some("total");
    }
    if normalized.contains("date")
        || normalized.contains("echeance")
        || normalized.contains("emission")
        || text.contains('/')
    {
        return Some("date");
    }
    if normalized.contains("facture")
        || normalized.contains("invoice")
        || normalized.contains("avoir")
        || normalized.contains("devis")
    {
        return Some("document_number");
    }
    if matches!(document_type, "invoice" | "credit_note" | "receipt" | "quote")
        && (normalized.contains("client")
            || normalized.contains("customer")
            || normalized.contains("fournisseur")
            || normalized.contains("supplier"))
    {
        return Some("party");
    }
    None
}

fn is_critical_field(kind: &str) -> bool {
    matches!(
        kind,
        "document_number" | "date" | "total" | "tax" | "company_id" | "vat_id" | "iban" | "party"
    )
}

fn annotate_document_intelligence(blocks: &mut [PdfEditBlock]) {
    let corpus = blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let (document_type, document_confidence) = classify_document_text(&corpus);
    for block in blocks.iter_mut().filter(|block| block.kind == "text") {
        block.confidence = block.confidence.max(document_confidence.min(96.0));
        block.diagnostics.push(format!("document:{document_type}"));
        if let Some(kind) = detect_field_kind(&block.text, document_type) {
            block.field_kind = Some(kind.to_string());
            block.critical = is_critical_field(kind);
            block.diagnostics.push(format!("field:{kind}"));
            if block.critical {
                block.diagnostics.push("critical_field".to_string());
            }
        }
    }
}

/// Découpe un segment PDFium contenant un grand blanc interne (tabulation,
/// cellules de tableau émises dans un seul run : « DATE␣␣␣␣REFERENCE »).
/// Sans ce découpage, les deux cellules forment un seul bloc éditable.
fn split_segment_on_column_gaps(segment: TextSegment) -> Vec<TextSegment> {
    if segment.chars.len() < 2 {
        return vec![segment];
    }
    let threshold = segment.height.max(segment.font_size).max(4.0) * 1.5;
    let is_ws = |c: &PdfCharBox| c.text.chars().all(char::is_whitespace);

    // Bornes [début, fin) des sous-parties, coupées entre deux caractères
    // visibles séparés par un blanc supérieur au seuil.
    let mut parts: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    let mut last_solid: Option<usize> = None;
    for index in 0..segment.chars.len() {
        if is_ws(&segment.chars[index]) {
            continue;
        }
        if let Some(prev) = last_solid {
            let a = &segment.chars[prev];
            let b = &segment.chars[index];
            // Les caractères d'une même ligne uniquement : un segment multi-lignes
            // ne doit pas être coupé sur le retour chariot (x repart à gauche).
            let same_line = (a.y - b.y).abs() <= a.height.max(b.height) * 0.6;
            let span = b.x - (a.x + a.width);
            if same_line && span > threshold {
                parts.push((start, prev + 1));
                start = index;
            }
        }
        last_solid = Some(index);
    }
    let end = last_solid.map(|i| i + 1).unwrap_or(segment.chars.len());
    parts.push((start, end));

    if parts.len() < 2 {
        return vec![segment];
    }

    parts
        .into_iter()
        .filter(|(s, e)| e > s)
        .map(|(s, e)| {
            let chars: Vec<PdfCharBox> = segment.chars[s..e].to_vec();
            let text: String = chars.iter().map(|c| c.text.as_str()).collect();
            let x = chars.iter().map(|c| c.x).fold(f64::INFINITY, f64::min);
            let y = chars.iter().map(|c| c.y).fold(f64::INFINITY, f64::min);
            let right = chars
                .iter()
                .map(|c| c.x + c.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = chars
                .iter()
                .map(|c| c.y + c.height)
                .fold(f64::NEG_INFINITY, f64::max);
            TextSegment {
                text: text.trim().to_string(),
                x,
                y,
                width: right - x,
                height: bottom - y,
                chars,
                ..segment.clone()
            }
        })
        .collect()
}

fn cluster_segments_into_lines(
    mut segments: Vec<TextSegment>,
    v_rules: &[(f64, f64, f64, f64)],
) -> Vec<TextSegment> {
    if segments.is_empty() {
        return segments;
    }

    // Dédoublonnage GLOBAL par index de page : PDFium restitue parfois le même
    // caractère dans PLUSIEURS segments (rects fragmentés d'un même run). Quand
    // le doublon atterrit sur une autre ligne visuelle (bbox décalée), il
    // fabriquait une ligne fantôme (« 37,56 € » + « ,5 ») qui désalignait le
    // texte des glyphes.
    //
    // ATTRIBUTION GÉOMÉTRIQUE, pas « premier arrivé » : dans les PDF découpés
    // glyphe par glyphe (reçus Stripe/Inter), chaque segment contient AUSSI le
    // caractère suivant. Garder la première occurrence volait le glyphe du
    // segment suivant — le segment de fin de mot (« A␣ ») ne conservait qu'une
    // espace et était jeté, les trous entre mots doublaient et les lignes se
    // coupaient mot par mot. Chaque caractère revient au segment dont la boîte
    // le contient ; à défaut, à sa première occurrence.
    {
        // page_char_index → (ordinal du segment retenu, recouvrement horizontal)
        let mut owner: std::collections::BTreeMap<i64, (usize, f64)> =
            std::collections::BTreeMap::new();
        for (si, segment) in segments.iter().enumerate() {
            let seg_right = segment.x + segment.width;
            for c in &segment.chars {
                if c.page_char_index < 0 {
                    continue;
                }
                let overlap =
                    (c.x + c.width).min(seg_right) - c.x.max(segment.x);
                match owner.entry(c.page_char_index) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert((si, overlap));
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        if overlap > entry.get().1 {
                            entry.insert((si, overlap));
                        }
                    }
                }
            }
        }
        segments = segments
            .into_iter()
            .enumerate()
            .filter_map(|(si, mut segment)| {
                if segment.chars.is_empty() {
                    return Some(segment);
                }
                segment.chars.retain(|c| {
                    c.page_char_index < 0
                        || owner
                            .get(&c.page_char_index)
                            .map(|&(owner_si, _)| owner_si == si)
                            .unwrap_or(true)
                });
                let has_real_char = segment
                    .chars
                    .iter()
                    .any(|c| !c.text.chars().all(char::is_whitespace));
                has_real_char.then_some(segment)
            })
            .collect();
    }
    if segments.is_empty() {
        return segments;
    }

    segments.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    // Métriques verticales d'un segment pour le regroupement en lignes : les
    // BOÎTES LOOSE des caractères (hauteur uniforme par ligne) plutôt que la
    // bbox du segment, serrée sur l'encre — une virgule seule a une boîte
    // minuscule près de la ligne de base et partait sur une « ligne » à part.
    let vertical_metrics = |segment: &TextSegment| -> (f64, f64) {
        let mut top = f64::INFINITY;
        let mut bottom = f64::NEG_INFINITY;
        for c in &segment.chars {
            top = top.min(c.y);
            bottom = bottom.max(c.y + c.height);
        }
        if top.is_finite() && bottom > top {
            (top, bottom - top)
        } else {
            (segment.y, segment.height)
        }
    };

    let mut lines: Vec<Vec<TextSegment>> = Vec::new();
    for segment in segments {
        if let Some(line) = lines.last_mut() {
            let (ref_y, ref_h) = vertical_metrics(&line[0]);
            let (seg_y, seg_h) = vertical_metrics(&segment);
            let ref_center = ref_y + ref_h / 2.0;
            let seg_center = seg_y + seg_h / 2.0;
            let baseline_tol = ref_h.max(seg_h) * 0.5;
            if (ref_center - seg_center).abs() <= baseline_tol {
                line.push(segment);
                continue;
            }
        }
        lines.push(vec![segment]);
    }

    let mut merged = Vec::with_capacity(lines.len());
    for mut line in lines {
        line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let mut groups: Vec<Vec<TextSegment>> = Vec::new();
        for segment in line {
            if let Some(group) = groups.last_mut() {
                let last = group.last().unwrap();
                let gap = segment.x - (last.x + last.width);
                let height_ref = last.height.max(segment.height);
                // Un trait vertical (bordure de cellule) entre les deux segments
                // signale deux cellules de tableau distinctes : jamais fusionnées.
                let seg_top = last.y.min(segment.y);
                let seg_bottom = (last.y + last.height).max(segment.y + segment.height);
                let separated_by_rule = v_rules.iter().any(|&(rx, ry, rw, rh)| {
                    let rule_x = rx + rw / 2.0;
                    rule_x > last.x + last.width - 1.0
                        && rule_x < segment.x + 1.0
                        && ry < seg_bottom
                        && ry + rh > seg_top
                });
                if gap <= height_ref * 1.2 && !separated_by_rule {
                    group.push(segment);
                    continue;
                }
            }
            groups.push(vec![segment]);
        }

        for group in groups {
            let x = group.iter().map(|s| s.x).fold(f64::INFINITY, f64::min);
            let y = group.iter().map(|s| s.y).fold(f64::INFINITY, f64::min);
            let right = group
                .iter()
                .map(|s| s.x + s.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = group
                .iter()
                .map(|s| s.y + s.height)
                .fold(f64::NEG_INFINITY, f64::max);
            let (text, chars) = merge_segment_texts_and_chars(&group);
            let bold = group.iter().filter(|s| s.bold).count() * 2 >= group.len();
            let italic = group.iter().filter(|s| s.italic).count() * 2 >= group.len();
            let serif = group.iter().filter(|s| s.serif).count() * 2 >= group.len();
            let font_size = group.iter().map(|s| s.font_size).fold(0.0_f64, f64::max);
            let font_name = group
                .iter()
                .find(|s| !s.font_name.is_empty())
                .map(|s| s.font_name.clone())
                .unwrap_or_default();
            merged.push(TextSegment {
                text,
                x,
                y,
                width: (right - x).max(1.0),
                height: (bottom - y).max(1.0),
                font_size,
                bold,
                italic,
                serif,
                font_name,
                justified: false,
                chars,
            });
        }
    }

    merged
}

/// Regroupe des lignes consécutives en paragraphes éditables d'un bloc.
/// Critères : même marge gauche, interligne régulier, taille de police proche.
/// On évite de fusionner colonnes/tableaux grâce à l'alignement gauche strict.
///
/// Non branché sur le chemin d'analyse principal (atome = 1 ligne). Conservé
/// pour outils / revert éventuel.
#[allow(dead_code)]
fn cluster_lines_into_paragraphs(
    mut lines: Vec<TextSegment>,
    h_rules: &[(f64, f64, f64, f64)],
) -> Vec<TextSegment> {
    if lines.len() < 2 {
        return lines;
    }
    lines.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    // Pour chaque ligne, on cherche le MEILLEUR groupe compatible (le plus proche
    // au-dessus, aligné à gauche) et pas seulement le dernier : les lignes d'un
    // paragraphe peuvent être entrecoupées par des cellules de tableau triées par y.
    let mut groups: Vec<Vec<TextSegment>> = Vec::new();
    for line in lines {
        let mut best_idx: Option<usize> = None;
        let mut best_prev_y = f64::NEG_INFINITY;
        for (gi, group) in groups.iter().enumerate() {
            let prev = group.last().unwrap();
            let ref_size = prev.font_size.max(line.font_size).max(1.0);
            let left_aligned = (prev.x - line.x).abs() <= (ref_size * 1.2).max(6.0);
            let pitch = line.y - prev.y;
            let regular_pitch = pitch > 0.0 && pitch <= ref_size * 2.4;
            let similar_size = (prev.font_size - line.font_size).abs() <= ref_size * 0.25;
            let prev_full = prev.width >= line.width * 0.4;
            // Deux lignes de styles différents (gras/italique/police) ne font jamais
            // partie du même paragraphe : un en-tête gras ("Code") suivi d'une valeur
            // normale ("V1") doit donner deux blocs distincts.
            let same_style = prev.bold == line.bold
                && prev.italic == line.italic
                && (prev.font_name.is_empty()
                    || line.font_name.is_empty()
                    || prev.font_name == line.font_name);
            // Un trait horizontal (bordure de rangée de tableau) entre les deux
            // lignes signale deux rangées distinctes : jamais le même paragraphe.
            let prev_bottom = prev.y + prev.height;
            let overlap_left = prev.x.max(line.x);
            let overlap_right = (prev.x + prev.width).min(line.x + line.width);
            let separated_by_rule = h_rules.iter().any(|&(rx, ry, rw, rh)| {
                let rule_y = ry + rh / 2.0;
                rule_y > prev_bottom - 1.0
                    && rule_y < line.y + 1.0
                    && rx < overlap_right
                    && rx + rw > overlap_left
            });
            if left_aligned
                && regular_pitch
                && similar_size
                && same_style
                && prev_full
                && !separated_by_rule
                && prev.y > best_prev_y
            {
                best_prev_y = prev.y;
                best_idx = Some(gi);
            }
        }
        match best_idx {
            Some(gi) => groups[gi].push(line),
            None => groups.push(vec![line]),
        }
    }

    groups
        .into_iter()
        .map(|group| {
            if group.len() == 1 {
                return group.into_iter().next().unwrap();
            }
            let x = group.iter().map(|s| s.x).fold(f64::INFINITY, f64::min);
            let y = group.iter().map(|s| s.y).fold(f64::INFINITY, f64::min);
            let right = group
                .iter()
                .map(|s| s.x + s.width)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = group
                .iter()
                .map(|s| s.y + s.height)
                .fold(f64::NEG_INFINITY, f64::max);
            let text = group
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let font_size = group.iter().map(|s| s.font_size).fold(0.0_f64, f64::max);
            let bold = group.iter().filter(|s| s.bold).count() * 2 >= group.len();
            let italic = group.iter().filter(|s| s.italic).count() * 2 >= group.len();
            let serif = group.iter().filter(|s| s.serif).count() * 2 >= group.len();
            let font_name = group
                .iter()
                .find(|s| !s.font_name.is_empty())
                .map(|s| s.font_name.clone())
                .unwrap_or_default();
            let chars = merge_segment_chars(&group);
            // Justifié : la plupart des lignes (hors dernière) remplissent ~toute la
            // largeur de colonne. On le reproduira en édition (text-align: justify)
            // pour coller au rendu du PDF.
            let max_width = group.iter().map(|s| s.width).fold(0.0_f64, f64::max);
            let n = group.len();
            let full_lines = group
                .iter()
                .take(n - 1)
                .filter(|s| max_width > 0.0 && s.width >= max_width * 0.9)
                .count();
            let justified = n >= 2 && full_lines * 2 >= (n - 1).max(1);
            TextSegment {
                text,
                x,
                y,
                width: (right - x).max(1.0),
                height: (bottom - y).max(1.0),
                font_size,
                bold,
                italic,
                serif,
                font_name,
                justified,
                chars,
            }
        })
        .collect()
}

fn font_weight_value(weight: &PdfFontWeight) -> u32 {
    match weight {
        PdfFontWeight::Weight100 => 100,
        PdfFontWeight::Weight200 => 200,
        PdfFontWeight::Weight300 => 300,
        PdfFontWeight::Weight400Normal => 400,
        PdfFontWeight::Weight500 => 500,
        PdfFontWeight::Weight600 => 600,
        PdfFontWeight::Weight700Bold => 700,
        PdfFontWeight::Weight800 => 800,
        PdfFontWeight::Weight900 => 900,
        PdfFontWeight::Custom(value) => *value,
    }
}

fn detect_segment_style(segment: &PdfPageTextSegment) -> (bool, bool, bool, String, f64) {
    let Ok(chars) = segment.chars() else {
        return (false, false, false, String::new(), 0.0);
    };
    for ch in chars.iter() {
        if ch.unicode_char().map(|c| c.is_whitespace()).unwrap_or(true) {
            continue;
        }
        let font_size = ch.scaled_font_size().value as f64;
        let raw_name = ch.font_name();
        let name = raw_name.to_lowercase();
        // NB : sur de nombreux PDF, FPDFText_GetFontWeight renvoie des valeurs
        // incohérentes (régulier > gras). Le nom de police PostScript est le
        // signal fiable. On garde le poids uniquement comme appoint très marqué.
        let weight_bold = ch
            .font_weight()
            .map(|w| font_weight_value(&w) >= 700)
            .unwrap_or(false)
            && (name.contains("bold") || name.contains("black") || name.contains("heavy"));
        let bold = weight_bold
            || ch.font_is_bold_reenforced()
            || name.contains("bold")
            || name.contains("black")
            || name.contains("heavy")
            || name.contains("semibold")
            || name.contains("-bd")
            || name.ends_with("bd");
        let italic = ch.font_is_italic() || name.contains("italic") || name.contains("oblique");
        let serif = ch.font_is_serif();
        return (bold, italic, serif, raw_name, font_size);
    }
    (false, false, false, String::new(), 0.0)
}

fn extract_segment_chars(segment: &PdfPageTextSegment, page_height: f64) -> Vec<PdfCharBox> {
    let Ok(chars) = segment.chars() else {
        return Vec::new();
    };

    // Espaces GÉNÉRÉS par l'extraction de texte PDFium (écart de crénage ou
    // tabulation rendus comme « espace » dans segment.text()) : leurs boîtes
    // sont vides, ils étaient jetés — le TEXTE du bloc portait alors un espace
    // sans caractère correspondant, ce qui désalignait texte ↔ caractères et
    // interdisait l'édition native de tout texte créné. On les conserve en
    // mémorisant leur index, puis on leur synthétise une boîte entre leurs
    // voisins (seconde passe ci-dessous).
    let mut boxes = Vec::new();
    let mut pending_ws: Vec<i64> = Vec::new();
    let mut gaps: Vec<(usize, Vec<i64>)> = Vec::new(); // (insertion avant boxes[i], index page)
    for ch in chars.iter() {
        let Some(value) = ch.unicode_char() else {
            continue;
        };
        if value == '\r' || value == '\n' {
            continue;
        }

        let loose = ch.loose_bounds().ok();
        let tight = ch.tight_bounds().ok();
        // Loose en priorité : hauteur uniforme par ligne et largeur d'avance des
        // espaces (le tight d'un espace est vide => le caractère disparaissait).
        let main_opt = loose.as_ref().or(tight.as_ref());
        let usable = main_opt
            .map(|rect| rect.width().value > 0.0 && rect.height().value > 0.0)
            .unwrap_or(false);
        if !usable {
            if value.is_whitespace() && !boxes.is_empty() {
                pending_ws.push(ch.index() as i64);
            }
            continue;
        }
        let main = main_opt.unwrap();
        if !pending_ws.is_empty() {
            gaps.push((boxes.len(), std::mem::take(&mut pending_ws)));
        }

        let mask = tight
            .as_ref()
            .filter(|rect| rect.width().value > 0.0 && rect.height().value > 0.0)
            .unwrap_or(main);

        boxes.push(PdfCharBox {
            text: value.to_string(),
            x: main.left().value as f64,
            y: page_height - main.top().value as f64,
            width: main.width().value as f64,
            height: main.height().value as f64,
            mask_x: mask.left().value as f64,
            mask_y: page_height - mask.top().value as f64,
            mask_width: mask.width().value as f64,
            mask_height: mask.height().value as f64,
            page_char_index: ch.index() as i64,
        });
    }

    // Seconde passe : boîtes synthétiques des espaces générés, réparties dans
    // le blanc entre le caractère précédent et le suivant (même ligne exigée).
    for (insert_at, ws_indices) in gaps.into_iter().rev() {
        let (Some(prev), Some(next)) = (
            insert_at.checked_sub(1).and_then(|i| boxes.get(i)),
            boxes.get(insert_at),
        ) else {
            continue;
        };
        let same_line = (prev.y - next.y).abs() <= prev.height.max(next.height) * 0.6;
        let gap_left = prev.x + prev.width;
        let gap_width = next.x - gap_left;
        if !same_line || gap_width <= 0.0 {
            continue;
        }
        let slice = gap_width / ws_indices.len() as f64;
        let y = prev.y.min(next.y);
        let height = prev.height.max(next.height);
        let synthesized: Vec<PdfCharBox> = ws_indices
            .iter()
            .enumerate()
            .map(|(k, &page_char_index)| PdfCharBox {
                text: " ".to_string(),
                x: gap_left + slice * k as f64,
                y,
                width: slice,
                height,
                mask_x: gap_left + slice * k as f64,
                mask_y: y,
                mask_width: slice,
                mask_height: height,
                page_char_index,
            })
            .collect();
        boxes.splice(insert_at..insert_at, synthesized);
    }

    boxes.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    boxes
}

pub fn analyze_pdf_page(bytes: &[u8], page: u32) -> Result<PdfAnalysis, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    match analyze_with_pdfium(bytes, page) {
        Ok(analysis) => return Ok(analysis),
        Err(error) => {
            tracing::warn!(
                "PDFium analysis unavailable, falling back to frontend text scan: {error}"
            );
        }
    }

    Ok(PdfAnalysis {
        page,
        page_width: 0.0,
        page_height: 0.0,
        blocks: Vec::new(),
        engine: "alto-native-pdf-fallback".to_string(),
    })
}

/// Normalise un nom de police pour un matching robuste avec `fontName` côté front
/// (issu de `char.font_name()`) : retire le préfixe de sous-ensemble « ABCDEF+ »
/// et met en minuscules.
fn normalize_font_key(name: &str) -> String {
    let s = name.trim();
    let base = if s.len() > 7
        && s.as_bytes()[6] == b'+'
        && s.as_bytes()[..6].iter().all(u8::is_ascii_uppercase)
    {
        &s[7..]
    } else {
        s
    };
    base.to_lowercase()
}

/// Encodeur base64 sans dépendance externe (octets de police → texte JSON compact).
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Extrait les polices EMBARQUÉES d'une page (le fichier de police complet, via
/// `FPDFFont_GetFontData`), indexées par nom PostScript de base normalisé. Le
/// front charge ces octets dans la WebView (FontFace) pour que l'aperçu d'édition
/// utilise la VRAIE police du PDF : métriques identiques au rendu natif, donc
/// supprimer/éditer un caractère ne rétrécit plus ni ne décale le texte. Octets
/// renvoyés en base64 pour limiter la taille du JSON IPC.
pub fn extract_embedded_fonts(
    bytes: &[u8],
    page: u32,
) -> Result<std::collections::HashMap<String, String>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_index = page
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
    let page = document
        .pages()
        .get(page_index)
        .map_err(|e| e.to_string())?;

    let mut fonts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for object in page.objects().iter() {
        if object.object_type() != PdfPageObjectType::Text {
            continue;
        }
        let Some(text_object) = object.as_text_object() else {
            continue;
        };
        let font = text_object.font();
        let key = normalize_font_key(&font.name());
        if key.is_empty() || fonts.contains_key(&key) {
            continue;
        }
        // `data()` renvoie le fichier de police complet (TrueType/OpenType pour la
        // grande majorité des PDF). Les Type1/CFF non chargeables par FontFace
        // seront simplement ignorés côté front (repli sur la police installée).
        if let Ok(data) = font.data() {
            if data.len() > 32 {
                fonts.insert(key, base64_encode(&data));
            }
        }
    }
    Ok(fonts)
}

fn rect_overlaps_text(
    text_boxes: &[(f64, f64, f64, f64)],
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    ratio: f64,
) -> bool {
    let area = width * height;
    if area <= 0.0 {
        return false;
    }
    for &(tx, ty, tw, th) in text_boxes {
        let text_area = tw * th;
        if text_area <= 0.0 {
            continue;
        }
        let inter_left = x.max(tx);
        let inter_top = y.max(ty);
        let inter_right = (x + width).min(tx + tw);
        let inter_bottom = (y + height).min(ty + th);
        if inter_right <= inter_left || inter_bottom <= inter_top {
            continue;
        }
        let intersection = (inter_right - inter_left) * (inter_bottom - inter_top);
        if intersection > text_area * ratio || intersection > area * ratio {
            return true;
        }
    }
    false
}

fn analyze_with_pdfium(bytes: &[u8], page: u32) -> Result<PdfAnalysis, String> {
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_index = page
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
    let page = document
        .pages()
        .get(page_index)
        .map_err(|e| e.to_string())?;
    let page_width = page.width().value as f64;
    let page_height = page.height().value as f64;
    let text = page.text().map_err(|e| e.to_string())?;

    // Traits fins (bordures de tableau) : utilisés comme séparateurs pour ne
    // jamais fusionner deux cellules ou deux rangées dans un même bloc éditable.
    let mut h_rules: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut v_rules: Vec<(f64, f64, f64, f64)> = Vec::new();
    for object in page.objects().iter() {
        let kind = object.object_type();
        if kind == PdfPageObjectType::Text || kind == PdfPageObjectType::Image {
            continue;
        }
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let px = bounds.left().value as f64;
        let py = page_height - bounds.top().value as f64;
        let pw = bounds.width().value as f64;
        let ph = bounds.height().value as f64;
        if ph <= 2.5 && pw >= 10.0 {
            h_rules.push((px, py, pw, ph));
        } else if pw <= 2.5 && ph >= 6.0 {
            v_rules.push((px, py, pw, ph));
        } else if pw >= 10.0 && ph >= 6.0 {
            // Cellules de tableau dessinées comme des RECTANGLES au trait (et non
            // des lignes fines) : chaque arête visible devient un séparateur.
            let stroked = object
                .as_path_object()
                .map(|path| path.is_stroked().unwrap_or(false))
                .unwrap_or(false);
            let visible_stroke = object
                .stroke_color()
                .map(|c| c.alpha() > 0 && (c.red() < 240 || c.green() < 240 || c.blue() < 240))
                .unwrap_or(false);
            if stroked && visible_stroke {
                h_rules.push((px, py, pw, 0.0));
                h_rules.push((px, py + ph, pw, 0.0));
                v_rules.push((px, py, 0.0, ph));
                v_rules.push((px + pw, py, 0.0, ph));
            }
        }
    }

    let raw_segments: Vec<TextSegment> = text
        .segments()
        .iter()
        .filter_map(|segment| {
            let content = segment.text().trim().to_string();
            if content.is_empty() {
                return None;
            }
            let bounds = segment.bounds();
            let mut x = bounds.left().value as f64;
            let mut y = page_height - bounds.top().value as f64;
            let mut width = bounds.width().value as f64;
            let mut height = bounds.height().value as f64;
            let (bold, italic, serif, font_name, font_size) = detect_segment_style(&segment);
            let chars = extract_segment_chars(&segment, page_height);
            if width <= 1.0 || height <= 1.0 {
                // Boîte d'ENCRE dégénérée : un segment réduit à un tiret ou un
                // point (ex : run scindé par une édition du flux) a une boîte
                // de 0,8 pt de haut. Le jeter ferait DISPARAÎTRE le caractère
                // de l'analyse — reprendre l'union des boîtes loose des
                // caractères, qui portent la hauteur de ligne réelle.
                // Uniquement pour des caractères IMPRIMABLES : un glyphe de
                // contrôle à l'encre sub-pixel est un artefact, pas du texte.
                if !content.chars().any(|c| !c.is_whitespace() && !c.is_control()) {
                    return None;
                }
                let mut left = f64::INFINITY;
                let mut top = f64::INFINITY;
                let mut right = f64::NEG_INFINITY;
                let mut bottom = f64::NEG_INFINITY;
                for c in &chars {
                    if c.width > 0.0 && c.height > 0.0 {
                        left = left.min(c.x);
                        top = top.min(c.y);
                        right = right.max(c.x + c.width);
                        bottom = bottom.max(c.y + c.height);
                    }
                }
                if left.is_finite() && right - left > 1.0 && bottom - top > 1.0 {
                    x = left;
                    y = top;
                    width = right - left;
                    height = bottom - top;
                } else {
                    return None;
                }
            }
            Some(TextSegment {
                text: content,
                x,
                y,
                width,
                height,
                font_size,
                bold,
                italic,
                serif,
                font_name,
                justified: false,
                chars,
            })
        })
        .flat_map(split_segment_on_column_gaps)
        .collect();

    let lines = cluster_segments_into_lines(raw_segments, &v_rules);
    // Atome d'édition = 1 ligne visuelle. Pas de fusion en paragraphe : la
    // sélection et l'édition partagent le même atome (éviter boîte multi-lignes
    // alors que la frappe n'accepte qu'une ligne). `cluster_lines_into_paragraphs`
    // et les traits horizontaux restent disponibles pour d'autres outils.
    let _ = &h_rules;
    let mut blocks: Vec<PdfEditBlock> = lines
        .into_iter()
        .enumerate()
        .map(|(index, segment)| PdfEditBlock {
            id: format!("pdfium-{}-{index}", page_index + 1),
            kind: "text".to_string(),
            page: page_index as u32 + 1,
            text: segment.text,
            x: segment.x,
            y: segment.y,
            width: segment.width,
            height: segment.height,
            font_size: segment.font_size,
            bold: segment.bold,
            italic: segment.italic,
            serif: segment.serif,
            font_name: segment.font_name,
            justified: segment.justified,
            chars: segment.chars,
            source: "pdfium".to_string(),
            confidence: 96.0,
            field_kind: None,
            critical: false,
            diagnostics: Vec::new(),
        })
        .collect();

    // Logos texte « multi-couches » : le même texte est estampé plusieurs fois
    // avec un léger décalage (faux gras), parfois via des glyphes sans
    // correspondance Unicode. La page texte de PDFium ne couvre que la couche
    // de base : on étend chaque bloc texte aux objets texte qui le chevauchent
    // presque entièrement, pour que le masque et l'instantané couvrent toutes
    // les couches (sinon, après déplacement, le bas des lettres reste visible
    // sous forme de petits tirets).
    for object in page.objects().iter() {
        if object.object_type() != PdfPageObjectType::Text {
            continue;
        }
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let ox = bounds.left().value as f64;
        let oy = page_height - bounds.top().value as f64;
        let ow = bounds.width().value as f64;
        let oh = bounds.height().value as f64;
        if ow <= 0.0 || oh <= 0.0 {
            continue;
        }
        let object_area = ow * oh;
        for block in blocks.iter_mut().filter(|b| b.kind == "text") {
            let inter_left = block.x.max(ox);
            let inter_top = block.y.max(oy);
            let inter_right = (block.x + block.width).min(ox + ow);
            let inter_bottom = (block.y + block.height).min(oy + oh);
            if inter_right <= inter_left || inter_bottom <= inter_top {
                continue;
            }
            let intersection = (inter_right - inter_left) * (inter_bottom - inter_top);
            if intersection < object_area * 0.6 {
                continue;
            }
            let new_x = block.x.min(ox);
            let new_y = block.y.min(oy);
            let new_right = (block.x + block.width).max(ox + ow);
            let new_bottom = (block.y + block.height).max(oy + oh);
            block.x = new_x;
            block.y = new_y;
            block.width = new_right - new_x;
            block.height = new_bottom - new_y;
            break;
        }
    }

    for (index, object) in page.objects().iter().enumerate() {
        if object.object_type() != PdfPageObjectType::Image {
            continue;
        }

        let Ok(bounds) = object.bounds() else {
            continue;
        };

        let x = bounds.left().value as f64;
        let y = page_height - bounds.top().value as f64;
        let width = bounds.width().value as f64;
        let height = bounds.height().value as f64;
        if width <= 2.0 || height <= 2.0 {
            continue;
        }
        // Un scan pleine page n'est pas une "image éditable" : la sélectionner
        // encadrerait toute la page (contour rouge). On la traite comme un fond.
        if width >= page_width * 0.85 && height >= page_height * 0.85 {
            continue;
        }
        // Pictos, puces, filets : trop petits pour un logo déplaçable, mais
        // assez pour poser un cadre rouge sur chaque ligne de texte voisine.
        let min_side = width.min(height);
        let max_side = width.max(height);
        if min_side < 14.0 {
            continue;
        }
        if max_side < 36.0 && width * height < 900.0 {
            continue;
        }

        blocks.push(PdfEditBlock {
            id: format!("pdfium-image-{}-{index}", page_index + 1),
            kind: "image".to_string(),
            page: page_index as u32 + 1,
            text: "Image".to_string(),
            x,
            y,
            width,
            height,
            font_size: 0.0,
            bold: false,
            italic: false,
            serif: false,
            font_name: String::new(),
            justified: false,
            chars: Vec::new(),
            source: "pdfium".to_string(),
            confidence: 90.0,
            field_kind: None,
            critical: false,
            diagnostics: Vec::new(),
        });
    }

    // Les logos sont souvent composés d'une image + de petits tracés vectoriels
    // (soulignement, swoosh, tirets décoratifs). On étend le bloc image pour les
    // inclure : déplacer le « logo » déplace alors l'ensemble, et le masque de
    // l'ancienne position couvre tout (sinon les tirets restent en place).
    let mut path_boxes: Vec<(f64, f64, f64, f64)> = Vec::new();
    for object in page.objects().iter() {
        // Tout sauf texte et images : tracés, dégradés, fragments de formulaire
        // (les logos Illustrator emballent souvent leurs éléments dans des
        // XObjects de type Form, pas dans des Path simples).
        let kind = object.object_type();
        if kind == PdfPageObjectType::Text || kind == PdfPageObjectType::Image {
            continue;
        }
        let Ok(bounds) = object.bounds() else {
            continue;
        };
        let px = bounds.left().value as f64;
        let py = page_height - bounds.top().value as f64;
        let pw = bounds.width().value as f64;
        let ph = bounds.height().value as f64;
        if pw <= 0.5 && ph <= 0.5 {
            continue;
        }
        // Règles, bordures de tableau et cadres pleine page : jamais absorbés.
        if pw >= page_width * 0.6 || ph >= page_height * 0.6 {
            continue;
        }
        path_boxes.push((px, py, pw, ph));
    }

    let text_boxes: Vec<(f64, f64, f64, f64)> = blocks
        .iter()
        .filter(|b| b.kind == "text")
        .map(|b| (b.x, b.y, b.width, b.height))
        .collect();

    for block in blocks.iter_mut().filter(|b| b.kind == "image") {
        let base_width = block.width;
        let base_height = block.height;
        let max_area = (base_width * base_height) * 2.0;
        const GAP: f64 = 8.0;
        let mut changed = true;
        while changed {
            changed = false;
            for &(px, py, pw, ph) in &path_boxes {
                // Seuls les petits tracés à l'échelle du logo d'origine sont absorbés.
                if pw > base_width * 1.4 || ph > base_height * 1.4 {
                    continue;
                }
                let near_x = px < block.x + block.width + GAP && px + pw > block.x - GAP;
                let near_y = py < block.y + block.height + GAP && py + ph > block.y - GAP;
                if !near_x || !near_y {
                    continue;
                }
                let nx = block.x.min(px);
                let ny = block.y.min(py);
                let nr = (block.x + block.width).max(px + pw);
                let nb = (block.y + block.height).max(py + ph);
                if (nr - nx) * (nb - ny) > max_area {
                    continue;
                }
                // Ne pas avaler un titre / paragraphe voisin (cadre rouge sur le texte).
                if rect_overlaps_text(&text_boxes, nx, ny, nr - nx, nb - ny, 0.18) {
                    continue;
                }
                if nx < block.x - 0.01
                    || ny < block.y - 0.01
                    || nr > block.x + block.width + 0.01
                    || nb > block.y + block.height + 0.01
                {
                    block.x = nx;
                    block.y = ny;
                    block.width = nr - nx;
                    block.height = nb - ny;
                    changed = true;
                }
            }
        }
    }

    // Fond / bandeau sous du texte : ce n'est pas un logo. Le garder poserait
    // un bloc image (contour rouge) par-dessus les caractères, inéditables.
    blocks.retain(|block| {
        if block.kind != "image" {
            return true;
        }
        !rect_overlaps_text(&text_boxes, block.x, block.y, block.width, block.height, 0.2)
    });

    annotate_document_intelligence(&mut blocks);

    Ok(PdfAnalysis {
        page: page_index as u32 + 1,
        page_width,
        page_height,
        blocks,
        engine: "pdfium".to_string(),
    })
}

// ─── Édition de texte NATIVE (façon Adobe) ──────────────────────────────────
// Modifie le texte D'UN OBJET TEXTE du PDF en place, via FPDFText_SetText : la
// police embarquée du document est réutilisée telle quelle, PDFium re-rend la
// page — même moteur, même police, même ligne de base. Aucune substitution,
// aucun overlay HTML : le problème de « micro-mouvement » ne peut pas exister.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextEditReport {
    /// Bande re-rendue de la page éditée (PNG base64), pleine largeur.
    pub strip_png_base64: String,
    /// Position/hauteur de la bande dans l'image pleine page, en PIXELS.
    pub strip_top_px: u32,
    pub strip_height_px: u32,
    /// Dimensions de l'image pleine page rendue (pour le mapping côté canvas).
    pub image_width_px: u32,
    pub image_height_px: u32,
    /// false si des caractères insérés n'ont pas de glyphe dans la police
    /// embarquée (sous-ensemble) : le frontend affiche le badge d'avertissement.
    pub glyphs_ok: bool,
    /// Ré-analyse complète de la page éditée (blocs + boîtes de caractères).
    pub analysis: PdfAnalysis,
}

pub struct NativeTextEditOutcome {
    /// Document complet ré-encodé avec l'édition (texte vectoriel préservé).
    pub bytes: Vec<u8>,
    pub report: NativeTextEditReport,
}

pub(crate) fn strip_whitespace(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Confirme que la ré-analyse reste TRAÇABLE côté UI. Cas nominal : un bloc au
/// texte exact attendu, à l'endroit attendu. Cas re-segmentation : quand le
/// texte élargi touche un bloc voisin, l'analyse peut fusionner/scinder les
/// lignes — le contenu du document est correct (validé par le contrôle de
/// fidélité), et le frontend sait DÉCOUPER ses caractères dans les blocs
/// fusionnés : on accepte si chaque ligne attendue reste présente dans un bloc
/// chevauchant le rect. Sans aucune de ces deux conditions, l'édition ne doit
/// PAS être commise (document modifié mais UI intraçable → double texte).
fn analysis_confirms_block(
    analysis: &PdfAnalysis,
    expected_text: &str,
    rect: (f64, f64, f64, f64),
) -> bool {
    let (bx, by, bw, bh) = rect;
    let overlapping: Vec<&PdfEditBlock> = analysis
        .blocks
        .iter()
        .filter(|b| {
            let left = bx.max(b.x);
            let top = by.max(b.y);
            let right = (bx + bw).min(b.x + b.width);
            let bottom = (by + bh).min(b.y + b.height);
            right > left && bottom > top
        })
        .collect();
    // Comparaison insensible aux blancs : les espaces « visuels » synthétisés
    // par l'analyse (écarts de crénage) peuvent apparaître/disparaître selon
    // la géométrie fine, sans que le CONTENU du document ait divergé.
    let expected_squeezed = strip_whitespace(expected_text);
    let exact = overlapping.iter().any(|b| {
        if strip_whitespace(&b.text) != expected_squeezed {
            return false;
        }
        let left = bx.max(b.x);
        let top = by.max(b.y);
        let right = (bx + bw).min(b.x + b.width);
        let bottom = (by + bh).min(b.y + b.height);
        let inter = (right - left) * (bottom - top);
        let min_area = (bw * bh).min(b.width * b.height).max(1.0);
        inter / min_area >= 0.3
    });
    if exact {
        return true;
    }
    expected_text
        .split('\n')
        .map(strip_whitespace)
        .filter(|line| !line.is_empty())
        .all(|line| {
            overlapping
                .iter()
                .any(|b| strip_whitespace(&b.text).contains(&line))
        })
}

/// Édition de texte native « intelligente » : tente d'abord le SPLICE du flux
/// de contenu (préserve crénage et colonnes — voir `pdf_stream_edit`), puis le
/// ré-encodage PDFium (`set_text`) si le splice n'est pas applicable. Les deux
/// chemins sont validés par le même contrôle de fidélité positionnel ; en cas
/// de double échec, le document reste intact et le frontend bascule en HTML.
///
/// `expected_block_text` + `block_rect` (points PDF) : vérification PRÉ-COMMIT
/// que la ré-analyse reste traçable côté UI (voir `analysis_confirms_block`).
#[allow(clippy::too_many_arguments)]
pub fn edit_pdf_text(
    bytes: &[u8],
    page_number: u32,
    removed_char_indices: &[u32],
    insert_after_char_index: i64,
    insert_before_char_index: i64,
    inserted: &str,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
    expected_block_text: Option<&str>,
    block_rect: Option<(f64, f64, f64, f64)>,
) -> Result<NativeTextEditOutcome, String> {
    edit_pdf_text_with_options(
        bytes,
        page_number,
        removed_char_indices,
        insert_after_char_index,
        insert_before_char_index,
        inserted,
        strip_top,
        strip_height,
        scale,
        expected_block_text,
        block_rect,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn edit_pdf_text_with_options(
    bytes: &[u8],
    page_number: u32,
    removed_char_indices: &[u32],
    insert_after_char_index: i64,
    insert_before_char_index: i64,
    inserted: &str,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
    expected_block_text: Option<&str>,
    block_rect: Option<(f64, f64, f64, f64)>,
    replace_whitespace_run: bool,
) -> Result<NativeTextEditOutcome, String> {
    let confirm = |outcome: NativeTextEditOutcome| -> Result<NativeTextEditOutcome, String> {
        if let (Some(expected), Some(rect)) = (expected_block_text, block_rect) {
            if !analysis_confirms_block(&outcome.report.analysis, expected, rect) {
                return Err("resegmented".to_string());
            }
        }
        Ok(outcome)
    };
    let stream_result = crate::pdf_stream_edit::edit_pdf_text_stream(
        bytes,
        page_number,
        removed_char_indices,
        insert_after_char_index,
        insert_before_char_index,
        inserted,
        strip_top,
        strip_height,
        scale,
        replace_whitespace_run,
    );
    let stream_err = match stream_result {
        Ok(outcome) => match confirm(outcome) {
            Ok(confirmed) => return Ok(confirmed),
            Err(e) => e,
        },
        Err(e) => e,
    };
    if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
        eprintln!("[stream-debug] chemin stream refusé : {stream_err}");
    }
    // Texte tronqué par un chemin de découpe NON élargissable, recouvert par
    // un fond peint après lui NON perçable, ou entrant en COLLISION avec la
    // suite de la ligne (positionnée par des Td explicites qui ne se décalent
    // pas) : `set_text` subirait le même sort (caractères invisibles ou
    // superposés — pire que le repli HTML, qui reste lisible). On ne tente
    // pas le second chemin.
    if stream_err == "clipped_insert"
        || stream_err == "covered_insert"
        || stream_err == "insert_collision"
    {
        return Err(stream_err);
    }
    match edit_pdf_text_native(
        bytes,
        page_number,
        removed_char_indices,
        insert_after_char_index,
        insert_before_char_index,
        inserted,
        strip_top,
        strip_height,
        scale,
    ) {
        Ok(outcome) => confirm(outcome),
        // « missing_glyphs » est porteur de sens côté frontend (badge police) :
        // le préserver quel que soit le chemin qui l'a produit.
        Err(native_err) => {
            // Le splice reste prioritaire et le chemin historique reste intact.
            // Si `set_text` a uniquement perdu le crénage, la nouvelle API
            // PDFium SetPositions rejoue l'édition depuis les octets ORIGINAUX
            // et restaure les origines de glyphes avant tout commit.
            if native_err == "layout_divergence" {
                match crate::pdf_positioned_edit::edit_pdf_text_positioned(
                    bytes,
                    page_number,
                    removed_char_indices,
                    insert_after_char_index,
                    insert_before_char_index,
                    inserted,
                    scale,
                ) {
                    Ok(outcome) => return confirm(outcome),
                    Err(positioned_err) => {
                        if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                            eprintln!(
                                "[stream-debug] chemin PDFium positionné refusé : {positioned_err}"
                            );
                        }
                    }
                }
            }
            if native_err == "missing_glyphs" || stream_err != "missing_glyphs" {
                Err(native_err)
            } else {
                Err(stream_err)
            }
        }
    }
}

/// Applique une édition de texte native sur la page donnée.
///
/// L'édition est décrite par la géométrie de la PAGE TEXTE PDFium :
/// - `removed_char_indices` : indices (page texte) des caractères supprimés ;
/// - `insert_after_char_index` : caractère APRÈS lequel insérer `inserted`
///   (-1 => utiliser `insert_before_char_index`) ;
/// - `insert_before_char_index` : caractère AVANT lequel insérer (-1 si aucun).
///
/// Contrainte v1 : tous les caractères touchés doivent appartenir au MÊME objet
/// texte (sinon `multi_object_edit`, le frontend retombe sur l'édition HTML).
#[allow(clippy::too_many_arguments)]
pub fn edit_pdf_text_native(
    bytes: &[u8],
    page_number: u32,
    removed_char_indices: &[u32],
    insert_after_char_index: i64,
    insert_before_char_index: i64,
    inserted: &str,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
) -> Result<NativeTextEditOutcome, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    if removed_char_indices.is_empty() && inserted.is_empty() {
        return Err("empty_edit".to_string());
    }
    if inserted.contains('\n') || inserted.contains('\r') {
        return Err("multiline_insert".to_string());
    }
    if !(scale > 0.0) || !(strip_height > 0.0) {
        return Err("invalid_strip".to_string());
    }

    let removed: std::collections::BTreeSet<i64> =
        removed_char_indices.iter().map(|&i| i as i64).collect();
    let mut anchor_indices: Vec<i64> = removed.iter().copied().collect();
    if insert_after_char_index >= 0 {
        anchor_indices.push(insert_after_char_index);
    }
    if insert_before_char_index >= 0 {
        anchor_indices.push(insert_before_char_index);
    }
    if anchor_indices.is_empty() {
        return Err("no_anchor".to_string());
    }

    let (out_bytes, report_parts) = {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        let page_index = page_number
            .checked_sub(1)
            .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
        let mut page = document
            .pages()
            .get(page_index)
            .map_err(|e| e.to_string())?;

        // 1) Localiser l'objet texte propriétaire des caractères touchés.
        //    On restreint la recherche aux objets dont la bbox contient les
        //    ancrages (évite un scan objets × caractères sur toute la page).
        // (index objet, [(index page, caractère, left pt, bottom pt)])
        let mut target: Option<(usize, Vec<(i64, char, f64, f64)>)> = None;
        {
            let text = page.text().map_err(|e| e.to_string())?;
            let all_chars = text.chars();
            let mut anchor_rects: Vec<(f64, f64, f64, f64)> = Vec::new();
            for &idx in &anchor_indices {
                if idx < 0 {
                    continue;
                }
                let Ok(ch) = all_chars.get(idx as usize) else {
                    return Err("char_index_out_of_range".to_string());
                };
                if let Ok(rect) = ch.loose_bounds() {
                    anchor_rects.push((
                        rect.left().value as f64,
                        rect.bottom().value as f64,
                        rect.right().value as f64,
                        rect.top().value as f64,
                    ));
                }
            }

            for (obj_index, object) in page.objects().iter().enumerate() {
                let Some(text_obj) = object.as_text_object() else {
                    continue;
                };
                // Filtre grossier : la bbox de l'objet doit toucher au moins un
                // ancrage (marge 2 pt pour l'anti-aliasing des bounds).
                if !anchor_rects.is_empty() {
                    let Ok(bounds) = object.bounds() else {
                        continue;
                    };
                    let ol = bounds.left().value as f64 - 2.0;
                    let ob = bounds.bottom().value as f64 - 2.0;
                    let or = bounds.right().value as f64 + 2.0;
                    let ot = bounds.top().value as f64 + 2.0;
                    let touches = anchor_rects.iter().any(|&(l, b, r, t)| {
                        l < or && r > ol && b < ot && t > ob
                    });
                    if !touches {
                        continue;
                    }
                }
                let chars = text
                    .chars_for_object(text_obj)
                    .map_err(|e| e.to_string())?;
                let indices: std::collections::BTreeSet<i64> =
                    chars.iter().map(|c| c.index() as i64).collect();
                let holds_all = anchor_indices.iter().all(|i| indices.contains(i));
                if !holds_all {
                    if anchor_indices.iter().any(|i| indices.contains(i)) {
                        // Édition à cheval sur plusieurs objets texte : non
                        // supporté en v1 (le frontend retombe sur l'HTML).
                        return Err("multi_object_edit".to_string());
                    }
                    continue;
                }
                let mut mapped = Vec::new();
                let mut min_bottom = f64::MAX;
                let mut max_top = f64::MIN;
                let mut max_height = 0.0f64;
                for c in chars.iter() {
                    let Some(u) = c.unicode_char() else {
                        // Glyphe sans correspondance Unicode : réécrire l'objet
                        // le corromprait. On refuse (fallback HTML côté app).
                        return Err("unmapped_glyph".to_string());
                    };
                    // Position d'origine du caractère : sert de référence au
                    // contrôle positionnel (ré-encodage identitaire ci-dessous).
                    let (left, bottom) = match c.loose_bounds() {
                        Ok(rect) => {
                            min_bottom = min_bottom.min(rect.bottom().value as f64);
                            max_top = max_top.max(rect.top().value as f64);
                            max_height = max_height.max(rect.height().value as f64);
                            (rect.left().value as f64, rect.bottom().value as f64)
                        }
                        Err(_) => (f64::NAN, f64::NAN),
                    };
                    mapped.push((c.index() as i64, u, left, bottom));
                }
                // Objet texte étalé sur plusieurs lignes : set_text produirait un
                // run mono-ligne (fusion des lignes). Non supporté → fallback HTML.
                if max_height > 0.0 && (max_top - min_bottom) > max_height * 1.8 {
                    return Err("multi_line_object".to_string());
                }
                // Objet texte étalé sur plusieurs COLONNES (grand saut de
                // positionnement interne, typique des rangées de tableau) :
                // set_text effondrerait les colonnes en un seul flux continu
                // (texte disparu d'une cellule, réapparu ailleurs). Refusé.
                let gap_threshold = max_height.max(4.0) * 1.5;
                for pair in mapped.windows(2) {
                    let (_, prev_u, prev_left, _) = pair[0];
                    let (_, _, next_left, _) = pair[1];
                    if prev_left.is_nan() || next_left.is_nan() {
                        continue;
                    }
                    // Approximation de l'avance du caractère précédent absente ici :
                    // on compare les origines. Un saut d'origine > seuil + une avance
                    // plausible (~1×hauteur pour le glyphe le plus large) = colonne.
                    let advance_allowance = if prev_u == ' ' { max_height } else { max_height * 1.2 };
                    if next_left - prev_left > gap_threshold + advance_allowance {
                        return Err("multi_column_object".to_string());
                    }
                }
                target = Some((obj_index, mapped));
                break;
            }
        }

        let (obj_index, obj_chars) = target.ok_or_else(|| "text_object_not_found".to_string())?;

        // Photographie du texte de page complet AVANT édition : `set_text`
        // ré-encode l'objet avec la police embarquée et peut ALTÉRER le
        // ToUnicode partagé par d'autres objets (police sous-ensemble) — leur
        // rendu reste correct mais leur EXTRACTION diverge (« z » lu « ] »).
        // On vérifie après coup que la page entière reste fidèle.
        let before_page: Vec<(i64, char)> = {
            let text = page.text().map_err(|e| e.to_string())?;
            let all = text.chars();
            let mut out = Vec::with_capacity(all.len());
            for i in 0..all.len() {
                if let Ok(c) = all.get(i) {
                    if let Some(u) = c.unicode_char() {
                        out.push((i as i64, u));
                    }
                }
            }
            out
        };

        // 2) Reconstruire le texte de l'objet avec le splice demandé. On garde en
        //    parallèle la position d'origine de chaque caractère CONSERVÉ et sa
        //    place par rapport au point d'édition (préfixe = avant : ne doit pas
        //    bouger ; suffixe = après : doit se décaler UNIFORMÉMENT), pour le
        //    contrôle positionnel post-édition.
        let min_removed = removed.iter().next().copied();
        let char_is_suffix = |idx: i64| -> bool {
            if let Some(m) = min_removed {
                if idx > m {
                    return true;
                }
            }
            if insert_before_char_index >= 0 && idx >= insert_before_char_index {
                return true;
            }
            if insert_after_char_index >= 0 && idx > insert_after_char_index {
                return true;
            }
            false
        };
        let mut new_text = String::new();
        let mut insert_done = false;
        // (left, bottom, is_suffix) de chaque caractère conservé, dans l'ordre.
        let mut kept_positions: Vec<(f64, f64, bool)> = Vec::new();
        let mut last_idx = i64::MIN;
        for (idx, u, left, bottom) in &obj_chars {
            // Le contrôle positionnel préfixe/suffixe exige un objet dont les
            // caractères sont dans l'ordre du texte de page. Sinon : refus.
            if *idx <= last_idx {
                return Err("unordered_object".to_string());
            }
            last_idx = *idx;
            if !insert_done
                && insert_after_char_index < 0
                && insert_before_char_index >= 0
                && *idx == insert_before_char_index
            {
                new_text.push_str(inserted);
                insert_done = true;
            }
            if !removed.contains(idx) {
                new_text.push(*u);
                kept_positions.push((*left, *bottom, char_is_suffix(*idx)));
            }
            if !insert_done && insert_after_char_index >= 0 && *idx == insert_after_char_index {
                new_text.push_str(inserted);
                insert_done = true;
            }
        }
        if !inserted.is_empty() && !insert_done {
            new_text.push_str(inserted);
        }
        let inserted_char_count = if inserted.is_empty() { 0 } else { inserted.chars().count() };
        let expected = strip_whitespace(&new_text);

        // Texte de PAGE attendu après édition (sans blancs) : l'édition
        // appliquée à la photographie d'avant.
        let expected_page: String = {
            let mut out = String::new();
            let mut insert_emitted = false;
            for &(idx, u) in &before_page {
                if !insert_emitted
                    && insert_after_char_index < 0
                    && insert_before_char_index >= 0
                    && idx == insert_before_char_index
                {
                    out.push_str(inserted);
                    insert_emitted = true;
                }
                if !removed.contains(&idx) {
                    out.push(u);
                }
                if !insert_emitted && insert_after_char_index >= 0 && idx == insert_after_char_index
                {
                    out.push_str(inserted);
                    insert_emitted = true;
                }
            }
            if !inserted.is_empty() && !insert_emitted {
                out.push_str(inserted);
            }
            strip_whitespace(&out)
        };

        // 3) Appliquer sur l'objet (PDFium ré-encode avec la police EMBARQUÉE).
        let mut applied = false;
        for (i, mut object) in page.objects().iter().enumerate() {
            if i != obj_index {
                continue;
            }
            let Some(text_obj) = object.as_text_object_mut() else {
                return Err("text_object_not_found".to_string());
            };
            // PDFium ne supporte pas les runs vides : on pose une espace.
            let value = if new_text.is_empty() { " " } else { new_text.as_str() };
            text_obj.set_text(value).map_err(|e| e.to_string())?;
            applied = true;
            break;
        }
        if !applied {
            return Err("text_object_not_found".to_string());
        }
        page.regenerate_content().map_err(|e| e.to_string())?;
        drop(page);

        let out_bytes = document.save_to_bytes().map_err(|e| e.to_string())?;

        // 4) Vérification des glyphes + re-rendu de la bande, sur le document
        //    RÉ-OUVERT (garantit que le contenu régénéré est bien pris en compte).
        //    Portée dédiée : doc2 emprunte out_bytes, il doit être relâché avant
        //    de déplacer les octets hors du bloc.
        let parts = {
            let doc2 = pdfium
                .load_pdf_from_byte_slice(&out_bytes, None)
                .map_err(|e| e.to_string())?;
            let page2 = doc2
                .pages()
                .get(page_index)
                .map_err(|e| e.to_string())?;
            let page_width = page2.width().value as f64;
            let page_height = page2.height().value as f64;

            // ── CONTRÔLE DE FIDÉLITÉ (obligatoire) ─────────────────────────
            // L'édition n'est validée QUE si le document ré-encodé est prouvé
            // fidèle : texte exact (aucun glyphe jeté par une police incomplète)
            // ET positions exactes (préfixe immobile, suffixe décalé d'un delta
            // UNIFORME). Tout écart — crénage personnalisé perdu, colonnes
            // effondrées, espacement modifié — rejette l'édition : l'appelant ne
            // met pas le document en cache, le fichier reste intact et le
            // frontend bascule en édition HTML.
            let glyphs_ok = true;
            {
                let text2 = page2.text().map_err(|e| e.to_string())?;
                let object = page2
                    .objects()
                    .iter()
                    .nth(obj_index)
                    .ok_or_else(|| "text_object_not_found".to_string())?;
                let text_obj = object
                    .as_text_object()
                    .ok_or_else(|| "text_object_not_found".to_string())?;
                let actual = strip_whitespace(&text2.for_object(text_obj));
                if actual != expected {
                    return Err("missing_glyphs".to_string());
                }
                // La PAGE ENTIÈRE doit rester fidèle : le ré-encodage d'un
                // objet peut corrompre l'extraction (voire les glyphes) des
                // AUTRES objets partageant la même police sous-ensemble.
                let actual_page: String = {
                    let all = text2.chars();
                    let mut out = String::new();
                    for i in 0..all.len() {
                        if let Ok(c) = all.get(i) {
                            if let Some(u) = c.unicode_char() {
                                if !u.is_whitespace() {
                                    out.push(u);
                                }
                            }
                        }
                    }
                    out
                };
                if actual_page != expected_page {
                    return Err("reencode_side_effects".to_string());
                }
                // Texte entièrement supprimé (l'objet porte une espace de
                // substitution) : rien à vérifier positionnellement.
                if new_text.is_empty() {
                    // Aucun caractère conservé → aucun contrôle possible ni requis.
                } else {
                let new_chars = text2
                    .chars_for_object(text_obj)
                    .map_err(|e| e.to_string())?;
                let mut new_positions: Vec<(f64, f64)> = Vec::new();
                for c in new_chars.iter() {
                    match c.loose_bounds() {
                        Ok(rect) => new_positions
                            .push((rect.left().value as f64, rect.bottom().value as f64)),
                        Err(_) => new_positions.push((f64::NAN, f64::NAN)),
                    }
                }
                if new_positions.len() != kept_positions.len() + inserted_char_count {
                    return Err("missing_glyphs".to_string());
                }
                const POSITION_TOLERANCE_PT: f64 = 0.35;
                let prefix_count = kept_positions.iter().filter(|k| !k.2).count();
                // Préfixe (avant le point d'édition) : positions STRICTEMENT
                // conservées. Le moindre déplacement = l'objet portait un
                // espacement personnalisé que set_text a détruit.
                for i in 0..prefix_count {
                    let (old_left, old_bottom, _) = kept_positions[i];
                    if old_left.is_nan() {
                        continue;
                    }
                    let (new_left, new_bottom) = new_positions[i];
                    if new_left.is_nan()
                        || (new_left - old_left).abs() > POSITION_TOLERANCE_PT
                        || (new_bottom - old_bottom).abs() > POSITION_TOLERANCE_PT
                    {
                        return Err("layout_divergence".to_string());
                    }
                }
                // Suffixe (après le point d'édition) : décalage horizontal
                // UNIFORME (largeur insérée − largeur supprimée), baseline
                // inchangée. Un delta non uniforme = effondrement de colonnes
                // ou perte d'ajustements internes.
                let mut common_delta: Option<f64> = None;
                for j in prefix_count..kept_positions.len() {
                    let (old_left, old_bottom, _) = kept_positions[j];
                    if old_left.is_nan() {
                        continue;
                    }
                    let (new_left, new_bottom) = new_positions[j + inserted_char_count];
                    if new_left.is_nan()
                        || (new_bottom - old_bottom).abs() > POSITION_TOLERANCE_PT
                    {
                        return Err("layout_divergence".to_string());
                    }
                    let delta = new_left - old_left;
                    match common_delta {
                        None => common_delta = Some(delta),
                        Some(reference) => {
                            if (delta - reference).abs() > POSITION_TOLERANCE_PT {
                                return Err("layout_divergence".to_string());
                            }
                        }
                    }
                }
                }
            }

            let target_width = ((page_width * scale).round() as i32).clamp(16, 8000);
            let rendered = page2
                .render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_width(target_width)
                        .render_form_data(true),
                )
                .map_err(|e| e.to_string())?
                .as_image()
                .map_err(|e| e.to_string())?;
            let image_width_px = rendered.width();
            let image_height_px = rendered.height();
            let px_per_pt = image_height_px as f64 / page_height.max(1.0);
            let strip_top_px = ((strip_top * px_per_pt).floor().max(0.0) as u32)
                .min(image_height_px.saturating_sub(1));
            let strip_height_px = (((strip_height * px_per_pt).ceil() as u32).max(1))
                .min(image_height_px - strip_top_px);
            let strip = rendered.crop_imm(0, strip_top_px, image_width_px, strip_height_px);
            let mut png = Vec::new();
            strip
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;

            (
                base64_encode(&png),
                strip_top_px,
                strip_height_px,
                image_width_px,
                image_height_px,
                glyphs_ok,
            )
        };

        (out_bytes, parts)
    };

    // Ré-analyse APRÈS avoir relâché le verrou PDFium (analyze_pdf_page le reprend).
    let analysis = analyze_pdf_page(&out_bytes, page_number)?;
    let (strip_png_base64, strip_top_px, strip_height_px, image_width_px, image_height_px, glyphs_ok) =
        report_parts;

    Ok(NativeTextEditOutcome {
        bytes: out_bytes,
        report: NativeTextEditReport {
            strip_png_base64,
            strip_top_px,
            strip_height_px,
            image_width_px,
            image_height_px,
            glyphs_ok,
            analysis,
        },
    })
}

// ─── Rendu pleine page PDFium ────────────────────────────────────────────────
// Sert à basculer le canvas frontend sur le rasteriseur PDFium AVANT la première
// frappe native : sans ça, la bande re-rendue après une frappe (PDFium) diffère
// subtilement du rendu PDF.js affiché (anti-aliasing), perçu comme un
// « changement d'état » du texte alors qu'aucun glyphe n'a bougé.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPagePng {
    pub png_base64: String,
    pub width_px: u32,
    pub height_px: u32,
}

pub fn render_pdf_page_png(bytes: &[u8], page_number: u32, scale: f64) -> Result<RenderedPagePng, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    if !(scale > 0.0) {
        return Err("invalid_scale".to_string());
    }
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_index = page_number
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;
    let page = document
        .pages()
        .get(page_index)
        .map_err(|e| e.to_string())?;
    let page_width = page.width().value as f64;
    let target_width = ((page_width * scale).round() as i32).clamp(16, 8000);
    let rendered = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(target_width)
                .render_form_data(true),
        )
        .map_err(|e| e.to_string())?
        .as_image()
        .map_err(|e| e.to_string())?;
    let width_px = rendered.width();
    let height_px = rendered.height();
    let mut png = Vec::new();
    rendered
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(RenderedPagePng {
        png_base64: base64_encode(&png),
        width_px,
        height_px,
    })
}

pub fn export_flattened_pdf(pages: Vec<FlattenedPage>) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("No rendered pages were provided for export.".to_string());
    }

    let mut objects = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());

    let page_count = pages.len();
    let kids = (0..page_count)
        .map(|index| format!("{} 0 R", 3 + index * 3))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!("<< /Type /Pages /Count {page_count} /Kids [{kids}] >>").into_bytes());

    for (index, page) in pages.into_iter().enumerate() {
        if page.jpeg_bytes.is_empty() {
            return Err("A rendered page image is empty.".to_string());
        }

        let page_object_id = 3 + index * 3;
        let image_object_id = page_object_id + 1;
        let content_object_id = page_object_id + 2;
        let image_name = format!("Im{}", index + 1);
        let width = page.width.max(1.0);
        let height = page.height.max(1.0);

        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2} {height:.2}] /Resources << /XObject << /{image_name} {image_object_id} 0 R >> >> /Contents {content_object_id} 0 R >>"
            )
            .into_bytes(),
        );

        let mut image_object = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            width.round() as u32,
            height.round() as u32,
            page.jpeg_bytes.len()
        )
        .into_bytes();
        image_object.extend(page.jpeg_bytes);
        image_object.extend(b"\nendstream");
        objects.push(image_object);

        let content = format!("q\n{width:.2} 0 0 {height:.2} 0 0 cm\n/{image_name} Do\nQ\n");
        objects.push(
            format!(
                "<< /Length {} >>\nstream\n{}endstream",
                content.len(),
                content
            )
            .into_bytes(),
        );
    }

    Ok(write_pdf(objects))
}

/// Retire l'objet `index` de la page SANS le détruire (même protection contre
/// le double-free que pdf_edit::remove_page_object : on neutralise le drop).
fn forget_remove_object(page: &mut PdfPage, index: usize) -> Result<(), String> {
    let removed = page
        .objects_mut()
        .remove_object_at_index(index)
        .map_err(|e| format!("Unable to remove object {index}: {e}"))?;
    std::mem::forget(removed);
    Ok(())
}

/// Export HYBRIDE de l'éditeur. À partir du PDF d'origine, ne remplace QUE les
/// pages réellement éditées par leur rendu aplati (JPEG pleine page) ; toutes
/// les autres pages restent intactes, donc leur texte/vecteurs natifs sont
/// préservés (sélectionnables, recherchables, nets à tout zoom, fichier léger).
///
/// `pages` peut contenir une entrée par page ; seules celles avec `jpeg_bytes`
/// non vide sont aplaties. Si aucune page n'est éditée, l'original est renvoyé
/// octet pour octet.
pub fn export_edited_pdf_native(original: &[u8], pages: Vec<EditedPage>) -> Result<Vec<u8>, String> {
    if !original.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    use std::collections::HashMap;
    let replacements: HashMap<u32, Vec<u8>> = pages
        .into_iter()
        .filter(should_flatten_edited_page)
        .map(|p| (p.page_number, p.jpeg_bytes))
        .collect();

    // Document non modifié : on conserve l'original intact (texte 100% natif).
    if replacements.is_empty() {
        return Ok(original.to_vec());
    }

    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(original, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;

    for page_number in 1..=page_count {
        let Some(jpeg) = replacements.get(&page_number) else {
            continue;
        };
        let image = image::load_from_memory(jpeg)
            .map_err(|e| format!("Unable to decode flattened page {page_number}: {e}"))?;

        let mut page = document
            .pages()
            .get((page_number - 1) as i32)
            .map_err(|e| e.to_string())?;
        let page_width = page.width().value as f64;
        let page_height = page.height().value as f64;

        // 1) Suppression de tous les objets natifs de la page : le contenu masqué
        //    ou édité n'est plus récupérable (équivalent à l'aplatissement, mais
        //    limité à cette seule page).
        let object_count = page.objects().len() as usize;
        for index in (0..object_count).rev() {
            forget_remove_object(&mut page, index)?;
        }

        // 2) Pose du rendu aplati en pleine page (origine bas-gauche du repère PDF).
        page.objects_mut()
            .create_image_object(
                PdfPoints::new(0.0),
                PdfPoints::new(0.0),
                &image,
                Some(PdfPoints::new(page_width as f32)),
                Some(PdfPoints::new(page_height as f32)),
            )
            .map_err(|e| format!("Unable to place flattened page {page_number}: {e}"))?;
        page.regenerate_content().map_err(|e| e.to_string())?;
    }

    document.save_to_bytes().map_err(|e| e.to_string())
}

fn vector_font_token_for(
    document: &mut PdfDocument,
    name: Option<&str>,
) -> Result<PdfFontToken, String> {
    let fonts = document.fonts_mut();
    let token = match name.unwrap_or("helvetica").to_ascii_lowercase().as_str() {
        "helvetica" | "helv" | "arial" => fonts.helvetica(),
        "helvetica-bold" | "helv-bold" => fonts.helvetica_bold(),
        "helvetica-oblique" | "helvetica-italic" => fonts.helvetica_oblique(),
        "times" | "times-roman" => fonts.times_roman(),
        "times-bold" => fonts.times_bold(),
        "times-italic" => fonts.times_italic(),
        "courier" | "mono" => fonts.courier(),
        "courier-bold" => fonts.courier_bold(),
        other => {
            return Err(format!(
                "Unsupported font '{other}'. Use one of: helvetica, helvetica-bold, helvetica-oblique, times, times-bold, times-italic, courier, courier-bold."
            ))
        }
    };
    Ok(token)
}

fn apply_ocr_visible_text_operation(
    bytes: &[u8],
    op: &VectorTextOperation,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let mut document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;
    if op.page_number == 0 || op.page_number > page_count {
        return Err(format!(
            "Page {} out of range (document has {page_count} pages, 1-based).",
            op.page_number
        ));
    }

    let mask_bbox = (op.bbox[0], op.bbox[1], op.bbox[2], op.bbox[3]);
    let target_raw = op.target_bbox.unwrap_or(op.bbox);
    let target_bbox = (target_raw[0], target_raw[1], target_raw[2], target_raw[3]);
    if mask_bbox.2 <= mask_bbox.0
        || mask_bbox.3 <= mask_bbox.1
        || target_bbox.2 <= target_bbox.0
        || target_bbox.3 <= target_bbox.1
    {
        return Err(format!("Invalid OCR vector bbox on page {}.", op.page_number));
    }

    let font = vector_font_token_for(&mut document, op.font.as_deref())?;
    let color = op
        .color
        .map(|rgb| PdfColor::new(rgb[0], rgb[1], rgb[2], 255))
        .unwrap_or_else(|| PdfColor::new(17, 17, 17, 255));
    let font_size = op
        .size
        .unwrap_or((target_bbox.3 - target_bbox.1) * 0.78)
        .clamp(3.5, 240.0);

    let natural_width = if op.text.trim().is_empty() {
        0.0
    } else {
        PdfPageTextObject::new(&document, &op.text, font, PdfPoints::new(font_size as f32))
            .and_then(|object| object.bounds())
            .map(|bounds| bounds.width().value as f64)
            .unwrap_or(0.0)
    };

    let mut page = document
        .pages()
        .get((op.page_number - 1) as i32)
        .map_err(|e| e.to_string())?;
    let page_height = page.height().value as f64;

    let pad = (font_size * 0.12).clamp(0.8, 3.0);
    let mask = (
        (mask_bbox.0 - pad).max(0.0),
        (mask_bbox.1 - pad).max(0.0),
        mask_bbox.2 + pad,
        mask_bbox.3 + pad,
    );
    let rect = PdfRect::new(
        PdfPoints::new((page_height - mask.3) as f32),
        PdfPoints::new(mask.0 as f32),
        PdfPoints::new((page_height - mask.1) as f32),
        PdfPoints::new(mask.2 as f32),
    );
    page.objects_mut()
        .create_path_object_rect(rect, None, None, Some(PdfColor::new(255, 255, 255, 255)))
        .map_err(|e| format!("Unable to mask OCR source region: {e}"))?;

    let mut warnings = Vec::new();
    if !op.text.trim().is_empty() {
        let target_width = (target_bbox.2 - target_bbox.0).max(0.1);
        let target_height = (target_bbox.3 - target_bbox.1).max(0.1);
        let scale_h = if natural_width > 0.1 {
            (target_width / natural_width).clamp(0.2, 5.0)
        } else {
            1.0
        };
        if !(0.45..=2.2).contains(&scale_h) {
            warnings.push(format!(
                "OCR text horizontal scale is {:.2}x; visual fidelity may differ.",
                scale_h
            ));
        }
        let mut x = target_bbox.0;
        if op.align.as_deref() == Some("center") && natural_width > 0.1 {
            x += ((target_width - natural_width * scale_h) / 2.0).max(0.0);
        } else if op.align.as_deref() == Some("right") && natural_width > 0.1 {
            x += (target_width - natural_width * scale_h).max(0.0);
        }
        let baseline_pdf = page_height - target_bbox.1 - (target_height - font_size * 0.78).max(0.0);
        let mut object = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(0.0),
                PdfPoints::new(0.0),
                &op.text,
                font,
                PdfPoints::new(font_size as f32),
            )
            .map_err(|e| format!("Unable to insert OCR vector text: {e}"))?;
        object
            .transform(scale_h as f32, 0.0, 0.0, 1.0, x as f32, baseline_pdf as f32)
            .map_err(|e| format!("Unable to position OCR vector text: {e}"))?;
        object.set_fill_color(color).map_err(|e| e.to_string())?;
    }

    page.regenerate_content().map_err(|e| e.to_string())?;
    let out = document.save_to_bytes().map_err(|e| e.to_string())?;
    Ok((out, warnings))
}

pub fn export_edited_pdf_vector(
    original: &[u8],
    operations: Vec<VectorTextOperation>,
) -> Result<VectorExportResult, String> {
    if !original.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    if operations.is_empty() {
        return Ok(VectorExportResult {
            bytes: original.to_vec(),
            applied: 0,
            warnings: Vec::new(),
        });
    }

    let mut current = original.to_vec();
    let mut warnings = Vec::new();
    let mut applied = 0usize;
    for op in operations {
        let bbox = (op.bbox[0], op.bbox[1], op.bbox[2], op.bbox[3]);
        if bbox.2 <= bbox.0 || bbox.3 <= bbox.1 {
            return Err(format!("Invalid vector edit bbox on page {}.", op.page_number));
        }
        if op.source.as_deref() == Some("ocr") {
            let (out, op_warnings) = apply_ocr_visible_text_operation(&current, &op)?;
            warnings.extend(op_warnings.into_iter().map(|warning| {
                format!("Page {} ({}): {warning}", op.page_number, op.reason)
            }));
            current = out;
            applied += 1;
            continue;
        }
        let color = op
            .color
            .map(|rgb| PdfColor::new(rgb[0], rgb[1], rgb[2], 255))
            .unwrap_or_else(|| PdfColor::new(17, 17, 17, 255));
        let target = op.target_bbox.map(|t| (t[0], t[1], t[2], t[3]));
        let outcome = crate::pdf_edit::edit_region_placed(
            &current,
            op.page_number,
            bbox,
            target,
            &op.text,
            op.font.as_deref(),
            op.font_bytes.as_deref(),
            op.size,
            color,
            op.align.as_deref().unwrap_or("left"),
            op.insert_only,
        )?;
        warnings.extend(outcome.warnings.into_iter().map(|warning| {
            format!("Page {} ({}): {warning}", op.page_number, op.reason)
        }));
        current = outcome.bytes;
        applied += 1;
    }

    Ok(VectorExportResult {
        bytes: current,
        applied,
        warnings,
    })
}

fn write_pdf(objects: Vec<Vec<u8>>) -> Vec<u8> {
    let mut pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len() + 1);
    offsets.push(0usize);

    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend(object);
        pdf.extend(b"\nendobj\n");
    }

    let xref_offset = pdf.len();
    pdf.extend(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend(b"0000000000 65535 f \n");
    for offset in offsets.iter().skip(1) {
        pdf.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }

    pdf.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );

    pdf
}

/// Répare un PDF en le rechargeant via PDFium (parseur tolérant) puis en le
/// réécrivant : reconstruit la table xref, normalise les flux et les objets.
pub fn repair_pdf(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    let guard = pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| format!("Unable to read this PDF: {e}"))?;
    if document.pages().is_empty() {
        return Err("This PDF has no readable page.".to_string());
    }
    document.save_to_bytes().map_err(|e| e.to_string())
}

/// Détecte les pages réellement blanches (rendu quasi entièrement blanc) et
/// renvoie le PDF nettoyé + la liste 1-indexée des pages retirées.
/// Conservateur : seuil très bas pour ne jamais supprimer une page utile.
pub fn remove_blank_pages(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u32>), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    let (blanks, total) = {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        let total = document.pages().len() as usize;
        let mut blanks = Vec::new();
        for (index, page) in document.pages().iter().enumerate() {
            let rendered = page
                .render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_width(160)
                        .render_form_data(true),
                )
                .map_err(|e| e.to_string())?
                .as_image()
                .map_err(|e| e.to_string())?
                .to_luma8();
            let pixel_count = (rendered.width() * rendered.height()).max(1) as f64;
            let mut marked = 0u64;
            for pixel in rendered.pixels() {
                if pixel[0] < 245 {
                    marked += 1;
                }
            }
            if (marked as f64 / pixel_count) < 0.002 {
                blanks.push(index as u32 + 1);
            }
        }
        (blanks, total)
    };

    if blanks.is_empty() {
        return Ok((bytes.to_vec(), blanks));
    }
    if blanks.len() >= total {
        return Err("Every page looks blank: nothing was removed.".to_string());
    }

    let out = crate::pdf_ops::delete_pages(bytes.to_vec(), blanks.clone())?;
    Ok((out, blanks))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn char_box(text: &str, x: f64, y: f64, w: f64, h: f64) -> PdfCharBox {
        PdfCharBox {
            text: text.to_string(),
            x,
            y,
            width: w,
            height: h,
            mask_x: x,
            mask_y: y,
            mask_width: w,
            mask_height: h,
            page_char_index: -1,
        }
    }

    fn segment(text: &str, x: f64, width: f64, font_size: f64, chars: Vec<PdfCharBox>) -> TextSegment {
        TextSegment {
            text: text.to_string(),
            x,
            y: 0.0,
            width,
            height: font_size,
            font_size,
            bold: false,
            italic: false,
            serif: false,
            font_name: String::new(),
            justified: false,
            chars,
        }
    }

    #[test]
    fn visual_space_inserted_on_large_gap_only() {
        let prev = segment("Hello", 0.0, 10.0, 12.0, vec![]);
        let near = segment("World", 11.0, 10.0, 12.0, vec![]);
        let far = segment("World", 20.0, 10.0, 12.0, vec![]);
        // Petit espace inter-mots typographique : pas d'espace forcé.
        assert!(!should_insert_visual_space(&prev, &near));
        // Grand blanc : espace logique inséré.
        assert!(should_insert_visual_space(&prev, &far));
    }

    #[test]
    fn visual_space_suppressed_before_punctuation() {
        let prev = segment("Total", 0.0, 10.0, 12.0, vec![]);
        let punct = segment(":", 30.0, 4.0, 12.0, vec![]);
        assert!(!should_insert_visual_space(&prev, &punct));
    }

    #[test]
    fn split_segment_splits_on_column_gap() {
        // Deux « cellules » sur la même ligne séparées par un grand blanc.
        let chars = vec![
            char_box("A", 0.0, 0.0, 8.0, 10.0),
            char_box("B", 40.0, 0.0, 8.0, 10.0),
        ];
        let seg = segment("AB", 0.0, 48.0, 10.0, chars);
        let parts = split_segment_on_column_gaps(seg);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].text, "A");
        assert_eq!(parts[1].text, "B");
    }

    #[test]
    fn split_segment_keeps_tight_text_together() {
        let chars = vec![
            char_box("A", 0.0, 0.0, 8.0, 10.0),
            char_box("B", 9.0, 0.0, 8.0, 10.0),
        ];
        let seg = segment("AB", 0.0, 17.0, 10.0, chars);
        let parts = split_segment_on_column_gaps(seg);
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn font_weight_mapping() {
        assert_eq!(font_weight_value(&PdfFontWeight::Weight400Normal), 400);
        assert_eq!(font_weight_value(&PdfFontWeight::Weight700Bold), 700);
        assert_eq!(font_weight_value(&PdfFontWeight::Custom(550)), 550);
    }

    #[test]
    fn write_pdf_produces_valid_skeleton() {
        let objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Count 0 /Kids [] >>".to_vec(),
        ];
        let pdf = write_pdf(objects);
        assert!(pdf.starts_with(b"%PDF-1.7"));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("xref"));
        assert!(text.contains("trailer"));
        assert!(text.contains("/Root 1 0 R"));
        assert!(text.trim_end().ends_with("%%EOF"));
    }

    #[test]
    fn native_export_rejects_non_pdf() {
        assert!(export_edited_pdf_native(b"not a pdf", vec![]).is_err());
    }

    // ── Édition native : contrôle de fidélité ────────────────────────────────
    // PDF générés reproduisant les cas d'échec observés en production :
    // objet multi-colonnes (tableaux), crénage personnalisé, glyphe manquant.

    /// PDF une page (300×100 pt) avec Helvetica et le flux de contenu donné.
    fn test_pdf_with_content(content_stream: &str) -> Vec<u8> {
        let content = format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            content_stream.len(),
            content_stream
        );
        let objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
                .to_vec(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_vec(),
            content.into_bytes(),
        ];
        write_pdf(objects)
    }

    fn literal_page_text(bytes: &[u8]) -> String {
        let document = lopdf::Document::load_mem(bytes).expect("document");
        let page_id = *document.get_pages().get(&1).expect("page");
        let content_bytes = document.get_page_content(page_id).expect("contenu");
        let content = lopdf::content::Content::decode(&content_bytes).expect("flux");
        let mut text = String::new();
        for operation in content.operations {
            match operation.operator.as_str() {
                "Tj" | "'" | "\"" => {
                    if let Some(lopdf::Object::String(bytes, _)) = operation.operands.last() {
                        text.push_str(&String::from_utf8_lossy(bytes));
                    }
                }
                "TJ" => {
                    if let Some(lopdf::Object::Array(items)) = operation.operands.first() {
                        for item in items {
                            if let lopdf::Object::String(bytes, _) = item {
                                text.push_str(&String::from_utf8_lossy(bytes));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        text
    }

    fn native_edit(
        bytes: &[u8],
        removed: &[u32],
        insert_after: i64,
        inserted: &str,
    ) -> Result<NativeTextEditOutcome, String> {
        edit_pdf_text(bytes, 1, removed, insert_after, -1, inserted, 0.0, 100.0, 1.0, None, None)
    }

    /// Variante de `test_pdf_with_content` avec un dictionnaire de police /F1
    /// arbitraire (sert à simuler un encodage restreint).
    fn test_pdf_with_font_and_content(font_dict: &str, content_stream: &str) -> Vec<u8> {
        let content = format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            content_stream.len(),
            content_stream
        );
        let objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
                .to_vec(),
            font_dict.as_bytes().to_vec(),
            content.into_bytes(),
        ];
        write_pdf(objects)
    }

    /// Boîtes (left, texte) de tous les caractères non blancs de la page 1,
    /// dans l'ordre : sert à vérifier l'immobilité positionnelle après splice.
    fn char_lefts(bytes: &[u8]) -> Vec<(String, f64)> {
        analyze_pdf_page(bytes, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .filter(|c| !c.text.trim().is_empty())
            .map(|c| (c.text.clone(), c.x))
            .collect()
    }

    fn pdfium_available() -> bool {
        if pdfium_guard().is_err() {
            eprintln!("PDFium indisponible : test d'édition native ignoré.");
            return false;
        }
        true
    }

    // Invariant clé de l'édition native : le TEXTE d'un bloc et sa liste de
    // CARACTÈRES sont alignés 1:1, y compris pour les espaces générés par
    // l'extraction de texte au niveau d'un écart de crénage. Sans cet
    // alignement, aucun bloc créné n'était éligible au natif (repli HTML avec
    // changement de police) et Cmd+Z émettait de fausses éditions inverses.
    #[test]
    fn analysis_text_and_chars_are_aligned_for_kerned_text() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td [(He) -300 (llo)] TJ ET");
        let analysis = analyze_pdf_page(&pdf, 1).expect("analyse");
        let block = analysis
            .blocks
            .iter()
            .find(|b| b.kind == "text")
            .expect("bloc texte");
        let char_text: String = block.chars.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(block.text, char_text, "texte et caractères désalignés");
        assert!(block.text.contains(' '), "l'espace visuel doit être présent");
        let mut last = -1i64;
        for c in &block.chars {
            assert!(c.page_char_index > last, "index page non croissants");
            last = c.page_char_index;
        }
    }

    #[test]
    fn positioned_fallback_preserves_kerning_when_stream_is_unavailable() {
        if !pdfium_available() {
            return;
        }
        // Le faux token BI placé dans un commentaire reproduit prudemment un
        // flux que le splice refuse (protection images inline), sans altérer le
        // rendu PDFium. `set_text` seul perdrait l'ajustement TJ de 300 unités ;
        // le repli SetPositions doit préserver le préfixe et le crénage suffixe.
        let pdf =
            test_pdf_with_content("% BI guard\nBT /F1 12 Tf 20 50 Td [(He) -300 (llo)] TJ ET");
        let before = char_lefts(&pdf);
        let e_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|block| block.chars.iter())
            .find(|character| character.text == "e")
            .expect("e")
            .page_char_index;
        let stream_error = match crate::pdf_stream_edit::edit_pdf_text_stream(
            &pdf,
            1,
            &[],
            e_index,
            -1,
            "X",
            0.0,
            100.0,
            1.0,
            false,
        ) {
            Ok(_) => panic!("le test doit forcer le repli hors stream"),
            Err(error) => error,
        };
        assert_eq!(stream_error, "inline_image_unsupported");

        let outcome = native_edit(&pdf, &[], e_index, "X").expect("repli positionné");
        let after = char_lefts(&outcome.bytes);
        let text: String = after
            .iter()
            .map(|(character, _)| character.as_str())
            .collect();
        assert_eq!(text, "HeXllo");
        assert!((after[0].1 - before[0].1).abs() <= 0.35);
        assert!((after[1].1 - before[1].1).abs() <= 0.35);
        assert!(((after[4].1 - after[3].1) - (before[3].1 - before[2].1)).abs() <= 0.35);
        assert!(((after[5].1 - after[4].1) - (before[4].1 - before[3].1)).abs() <= 0.35);
    }

    /// Décodage base64 + comptage des pixels sombres d'une bande verticale de
    /// la page rendue : sert à vérifier qu'un caractère est réellement PEINT
    /// (un caractère présent dans le text page mais tronqué par un clip est
    /// invisible à l'écran).
    fn dark_pixels_in_x_range(png_base64: &str, page_width: f64, x_min: f64, x_max: f64) -> u32 {
        let raw = {
            let mut out = Vec::new();
            let mut val = 0u32;
            let mut bits = 0u32;
            for c in png_base64.bytes() {
                let d = match c {
                    b'A'..=b'Z' => c - b'A',
                    b'a'..=b'z' => c - b'a' + 26,
                    b'0'..=b'9' => c - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    _ => continue,
                } as u32;
                val = (val << 6) | d;
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    out.push((val >> bits) as u8);
                }
            }
            out
        };
        let img = image::load(std::io::Cursor::new(raw), image::ImageFormat::Png)
            .expect("png")
            .to_rgb8();
        let scale = img.width() as f64 / page_width;
        let mut dark = 0u32;
        for (x, _y, p) in img.enumerate_pixels() {
            let lum = (p[0] as u32 + p[1] as u32 + p[2] as u32) / 3;
            let x_pt = x as f64 / scale;
            if lum < 128 && x_pt > x_min && x_pt < x_max {
                dark += 1;
            }
        }
        dark
    }

    // Texte sous un clip de cellule (re W n) : une insertion qui déborde du
    // clip doit rester VISIBLE — le moteur élargit le rectangle de découpe
    // (comportement Adobe). Sans élargissement, les caractères ajoutés
    // existaient dans le document mais étaient peints hors clip → invisibles.
    #[test]
    fn native_edit_widens_cell_clip_when_text_overflows() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content(
            "q 20 40 60 20 re W n BT /F1 12 Tf 22 45 Td (Hello) Tj ET Q",
        );
        let o_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("o")
            .page_char_index;
        let outcome = native_edit(&pdf, &[], o_index, "XXXXXXXXXX").expect("insertion");
        // Les X insérés s'étendent bien au-delà de l'ancien bord de clip (80).
        let lefts = char_lefts(&outcome.bytes);
        let max_left = lefts.iter().map(|(_, x)| *x).fold(0.0f64, f64::max);
        assert!(max_left > 90.0, "insertion trop courte pour le test : {max_left}");
        // Et ils sont PEINTS : pixels sombres présents au-delà de x=82.
        let report = render_pdf_page_png(&outcome.bytes, 1, 2.0).expect("rendu");
        let beyond = dark_pixels_in_x_range(&report.png_base64, 300.0, 82.0, 300.0);
        assert!(
            beyond > 50,
            "caractères insérés toujours tronqués par le clip ({beyond} px sombres au-delà)"
        );
        // Le préfixe n'a pas bougé.
        let before = char_lefts(&pdf);
        for (i, (c, x_before)) in before.iter().enumerate() {
            let (_, x_after) = lefts[i];
            assert!(
                (x_after - x_before).abs() <= 0.35,
                "préfixe déplacé : '{c}' {x_before} → {x_after}"
            );
        }
    }

    #[test]
    fn native_edit_punches_white_fill_painted_after_text() {
        if !pdfium_available() {
            return;
        }
        // Tableau typique : le fond BLANC de la cellule voisine est peint
        // APRÈS le texte édité (puis son propre texte). Sans perçage, le texte
        // inséré qui déborde est recouvert (invisible). Le tout sous une CTM
        // à l'échelle 0.5 pour valider la conversion espace local → page.
        let pdf = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td (Hello) Tj ET \
             q 0.5 0 0 0.5 0 0 cm 1 1 1 rg 120 60 400 80 re f Q \
             0 0 0 rg BT /F1 12 Tf 200 50 Td (End) Tj ET",
        );
        let o_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("o")
            .page_char_index;
        let outcome = native_edit(&pdf, &[], o_index, "XXXXXXXXXX").expect("insertion");
        // Les X insérés s'étendent au-delà du bord gauche du fond blanc (60pt).
        let lefts = char_lefts(&outcome.bytes);
        let max_left = lefts.iter().map(|(_, x)| *x).fold(0.0f64, f64::max);
        assert!(max_left > 70.0, "insertion trop courte pour le test : {max_left}");
        // Et ils sont PEINTS : pixels sombres entre le début du fond blanc et
        // le texte « End » (200pt), zone auparavant recouverte.
        let report = render_pdf_page_png(&outcome.bytes, 1, 2.0).expect("rendu");
        let beyond = dark_pixels_in_x_range(&report.png_base64, 300.0, 62.0, 195.0);
        assert!(
            beyond > 50,
            "caractères insérés toujours recouverts par le fond blanc ({beyond} px sombres)"
        );
        // Le texte « End » peint après le fond est intact.
        let text: String = analyze_pdf_page(&outcome.bytes, 1)
            .expect("analyse")
            .blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect();
        assert!(text.contains("End"), "texte voisin perdu : {text}");
    }

    #[test]
    fn native_edit_rejects_insert_covered_by_colored_fill() {
        if !pdfium_available() {
            return;
        }
        // Fond COLORÉ peint après le texte : non perçable sans altérer
        // l'aspect → l'édition doit être refusée (covered_insert), pas commise
        // avec des caractères invisibles.
        let pdf = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td (Hello) Tj ET \
             0.9 0.9 0.5 rg 60 30 200 40 re f",
        );
        let o_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("o")
            .page_char_index;
        let err = match native_edit(&pdf, &[], o_index, "XXXXXXXXXX") {
            Ok(_) => panic!("l'insertion recouverte par un fond coloré doit être refusée"),
            Err(e) => e,
        };
        assert_eq!(err, "covered_insert", "erreur inattendue : {err}");
    }

    #[test]
    fn native_edit_simple_insert_succeeds() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Hello World) Tj ET");
        // Insérer "X" après le "o" de "Hello" (index page 4).
        let outcome = native_edit(&pdf, &[], 4, "X").expect("insertion simple acceptée");
        let analysis = &outcome.report.analysis;
        let text: String = analysis.blocks.iter().map(|b| b.text.as_str()).collect();
        assert!(text.contains("HelloX"), "texte réécrit : {text}");
    }

    #[test]
    fn render_page_png_produces_full_page_image() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Hello World) Tj ET");
        let out = render_pdf_page_png(&pdf, 1, 2.0).expect("rendu pleine page");
        // MediaBox 300×100 pt à l'échelle 2 → ~600×200 px.
        assert_eq!(out.width_px, 600);
        assert!(out.height_px >= 190 && out.height_px <= 210, "hauteur: {}", out.height_px);
        assert!(!out.png_base64.is_empty());
    }

    #[test]
    fn native_edit_simple_delete_succeeds() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Hello World) Tj ET");
        // Supprimer le "o" de "Hello" (index page 4). Ancre = caractère précédent.
        let outcome = native_edit(&pdf, &[4], 3, "").expect("suppression simple acceptée");
        let analysis = &outcome.report.analysis;
        let text: String = analysis.blocks.iter().map(|b| b.text.as_str()).collect();
        assert!(text.contains("Hell World"), "texte réécrit : {text}");
    }

    #[test]
    fn native_edit_multi_column_keeps_columns_immobile() {
        if !pdfium_available() {
            return;
        }
        // Un SEUL objet texte, deux « cellules » séparées par un saut TJ de
        // 240 pt : la rangée de tableau typique. Le splice de flux (étape 2)
        // doit insérer dans la première cellule ET compenser le décalage à la
        // frontière : la seconde colonne ne bouge pas d'un micron.
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td [(Left) -20000 (Right)] TJ ET");
        let before = char_lefts(&pdf);
        let right_before: Vec<f64> = before.iter().skip(4).map(|(_, x)| *x).collect();
        assert_eq!(right_before.len(), 5, "5 caractères attendus dans 'Right'");

        // Insérer "X" après le "t" de "Left" (index page 3).
        let outcome = native_edit(&pdf, &[], 3, "X").expect("édition multi-colonnes acceptée");
        let text: String = outcome
            .report
            .analysis
            .blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("LeftX"), "texte réécrit : {text}");
        assert!(text.contains("Right"), "colonne droite disparue : {text}");

        let after = char_lefts(&outcome.bytes);
        // "LeftX" (5) + "Right" (5).
        assert_eq!(after.len(), 10, "caractères après édition : {after:?}");
        for (i, &x_before) in right_before.iter().enumerate() {
            let (ref c, x_after) = after[5 + i];
            assert!(
                (x_after - x_before).abs() <= 0.5,
                "colonne droite déplacée : '{c}' {x_before} → {x_after}"
            );
        }
    }

    #[test]
    fn native_edit_multi_column_delete_keeps_columns_immobile() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td [(Left) -20000 (Right)] TJ ET");
        let before = char_lefts(&pdf);
        let right_before: Vec<f64> = before.iter().skip(4).map(|(_, x)| *x).collect();

        // Supprimer le "e" de "Left" (index page 1). Ancre = caractère précédent.
        let outcome = native_edit(&pdf, &[1], 0, "").expect("suppression multi-colonnes acceptée");
        let after = char_lefts(&outcome.bytes);
        // "Lft" (3) + "Right" (5).
        assert_eq!(after.len(), 8, "caractères après suppression : {after:?}");
        for (i, &x_before) in right_before.iter().enumerate() {
            let (ref c, x_after) = after[3 + i];
            assert!(
                (x_after - x_before).abs() <= 0.5,
                "colonne droite déplacée : '{c}' {x_before} → {x_after}"
            );
        }
    }

    #[test]
    fn native_edit_second_column_keeps_first_column_immobile() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td [(Left) -20000 (Right)] TJ ET");
        let before = char_lefts(&pdf);
        let left_before: Vec<f64> = before.iter().take(4).map(|(_, x)| *x).collect();

        // Insérer "X" après le "R" de "Right" (index page résolu dynamiquement).
        let r_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "R")
            .expect("caractère R présent")
            .page_char_index;
        let outcome = native_edit(&pdf, &[], r_index, "X").expect("édition seconde colonne acceptée");
        let after = char_lefts(&outcome.bytes);
        // "Left" (4) + "RXight" (6).
        assert_eq!(after.len(), 10, "caractères après édition : {after:?}");
        for (i, &x_before) in left_before.iter().enumerate() {
            let (ref c, x_after) = after[i];
            assert!(
                (x_after - x_before).abs() <= 0.35,
                "colonne gauche déplacée : '{c}' {x_before} → {x_after}"
            );
        }
        let text: String = after.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(text, "LeftRXight", "texte après édition : {text}");
    }

    #[test]
    fn native_edit_survives_block_merge_from_widened_text() {
        if !pdfium_available() {
            return;
        }
        // Deux « cellules » côte à côte : le texte de gauche élargi par des
        // insertions répétées finit par toucher le texte de droite. Tant que
        // les glyphes ne se chevauchent pas, l'édition doit être ACCEPTÉE
        // (le bug d'origine : rejet « resegmented » dès que l'analyse
        // fusionnait les blocs, bien avant le contact). Au contact physique,
        // le moteur a le droit de REFUSER proprement (insert_collision → repli
        // HTML lisible) — jamais de superposer des glyphes ni de corrompre.
        let mut bytes = test_pdf_with_content(
            "BT /F1 10 Tf 20 50 Td (IACCESDIVE) Tj ET BT /F1 10 Tf 110 50 Td (ACCESSOIRES) Tj ET",
        );
        let mut expected = String::from("IACCESDIVE");
        for step in 0..14 {
            let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
            // L'ancre 'I' initial : premier caractère du document en ordre page.
            let anchor = analysis
                .blocks
                .iter()
                .flat_map(|b| b.chars.iter())
                .filter(|c| !c.text.trim().is_empty())
                .min_by_key(|c| c.page_char_index)
                .expect("ancre présente");
            assert_eq!(anchor.text, "I", "ancre inattendue à l'étape {step}");
            let mut e = expected.clone();
            e.insert(1, 'I');
            let outcome = match edit_pdf_text(
                &bytes,
                1,
                &[],
                anchor.page_char_index,
                -1,
                "I",
                0.0,
                100.0,
                1.0,
                Some(&e),
                None,
            ) {
                Ok(outcome) => outcome,
                Err(err) if err == "insert_collision" => {
                    // Contact physique avec le voisin : refus propre attendu.
                    // Le document n'a pas été modifié — fin du scénario.
                    assert!(
                        step >= 8,
                        "étape {step}: collision détectée trop tôt (les blocs sont loin)"
                    );
                    return;
                }
                Err(err) => panic!("étape {step}: édition refusée ({err})"),
            };
            bytes = outcome.bytes;
            expected = e;
            // Vérité document : chaque ligne attendue reste présente (l'analyse
            // peut avoir fusionné les deux cellules, comparaison par index page
            // dédupliqués — un chevauchement physique duplique les caractères
            // frontière dans deux segments).
            let re = analyze_pdf_page(&bytes, 1).expect("ré-analyse");
            let mut by_index: Vec<&PdfCharBox> = re
                .blocks
                .iter()
                .flat_map(|b| b.chars.iter())
                .filter(|c| !c.text.trim().is_empty() && c.page_char_index >= 0)
                .collect();
            by_index.sort_by_key(|c| c.page_char_index);
            by_index.dedup_by_key(|c| c.page_char_index);
            let doc_text: String = by_index.iter().map(|c| c.text.as_str()).collect();
            assert!(
                doc_text.contains(&expected),
                "étape {step}: document {doc_text:?} ne contient plus {expected:?}"
            );
            assert!(
                doc_text.contains("ACCESSOIRES"),
                "étape {step}: le voisin a été corrompu : {doc_text:?}"
            );
        }
    }

    #[test]
    fn native_edit_refuses_overrun_into_line_continuation() {
        if !pdfium_available() {
            return;
        }
        // Une même ligne scindée en deux show ops jointifs (« Calvi, le 16 »
        // + « mai 2026, ») : le second run ne se décale pas quand on insère
        // dans le premier — le suffixe déborderait dessus et l'ordre de
        // lecture serait corrompu (« 16m ai »). Refus attendu, jamais de
        // commit corrompu.
        // Largeurs Helvetica 12pt : « Calvi, le 16 » ≈ 66,7 pt.
        let bytes = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td (Calvi, le 16 ) Tj ET \
             BT /F1 12 Tf 87 50 Td (mai 2026,) Tj ET",
        );
        let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
        let anchor = analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "i" && c.page_char_index >= 0)
            .expect("ancre i de Calvi");
        match edit_pdf_text(
            &bytes,
            1,
            &[],
            anchor.page_char_index,
            -1,
            "e",
            0.0,
            100.0,
            1.0,
            None,
            None,
        ) {
            Err(err) => assert!(
                err.contains("insert_collision"),
                "refus attendu insert_collision, obtenu : {err}"
            ),
            Ok(outcome) => {
                // Si le moteur accepte, l'ordre de lecture doit être intact.
                let after = analyze_pdf_page(&outcome.bytes, 1).expect("ré-analyse");
                let text: String = after
                    .blocks
                    .iter()
                    .flat_map(|b| b.text.chars())
                    .filter(|c| !c.is_whitespace())
                    .collect();
                assert!(
                    text.contains("Calvie,le16mai2026,"),
                    "ordre de lecture corrompu : {text:?}"
                );
            }
        }
    }

    #[test]
    fn stream_edit_shifts_glyph_fragmented_line_suffix() {
        if !pdfium_available() {
            return;
        }
        // Famille réelle des reçus Stripe/Inter : un seul BT…ET, mais UN Tj
        // PAR GLYPHE, chaque glyphe suivant étant positionné par un Td relatif.
        // Insérer après le second « i » de « Silicon » doit décaler « con A1 »
        // dans la ligne — jamais superposer le « c », basculer en HTML ou
        // envoyer la frappe après « A1 ».
        let pdf = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td \
             (S) Tj 8.004 0 Td (i) Tj 2.664 0 Td (l) Tj 2.664 0 Td \
             (i) Tj 2.664 0 Td (c) Tj 6 0 Td (o) Tj 6.672 0 Td \
             (n) Tj 6.672 0 Td ( ) Tj 3.336 0 Td (A) Tj 8.004 0 Td (1) Tj ET",
        );
        let before = analyze_pdf_page(&pdf, 1).expect("analyse avant");
        let block = before
            .blocks
            .iter()
            .find(|b| strip_whitespace(&b.text).contains("SiliconA1"))
            .expect("ligne Silicon A1");
        let second_i = block
            .chars
            .iter()
            .filter(|c| c.text == "i")
            .nth(1)
            .expect("second i");
        let old_c_x = block
            .chars
            .iter()
            .find(|c| c.text == "c")
            .expect("c")
            .x;
        let old_a_x = block
            .chars
            .iter()
            .find(|c| c.text == "A")
            .expect("A")
            .x;

        let outcome = crate::pdf_stream_edit::edit_pdf_text_stream(
            &pdf,
            1,
            &[],
            second_i.page_char_index,
            -1,
            "i",
            0.0,
            100.0,
            1.0,
            false,
        )
        .expect("le chemin stream doit rester natif");
        let after = &outcome.report.analysis;
        let edited = after
            .blocks
            .iter()
            .find(|b| strip_whitespace(&b.text).contains("SiliiconA1"))
            .expect("texte inséré au bon endroit");
        let new_c_x = edited
            .chars
            .iter()
            .find(|c| c.text == "c")
            .expect("c après")
            .x;
        let new_a_x = edited
            .chars
            .iter()
            .find(|c| c.text == "A")
            .expect("A après")
            .x;
        assert!(
            new_c_x > old_c_x + 2.0 && new_a_x > old_a_x + 2.0,
            "le suffixe entier doit se décaler : c {old_c_x:.2}→{new_c_x:.2}, A {old_a_x:.2}→{new_a_x:.2}"
        );
        assert_eq!(edited.font_name, block.font_name, "la police ne doit pas changer");
    }

    #[test]
    fn stream_edit_deletes_from_glyph_fragmented_line_without_html_fallback() {
        if !pdfium_available() {
            return;
        }
        // Régression réelle : « Soflution » est émis avec un Tj par glyphe.
        // La suppression du « i » transmet encore les ancres voisines depuis
        // le frontend ; elles ne doivent pas provoquer `multi_object_edit`.
        let pdf = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td \
             (S) Tj 8.004 0 Td (o) Tj 6.672 0 Td (f) Tj 3.336 0 Td \
             (l) Tj 2.664 0 Td (u) Tj 6.672 0 Td (t) Tj 3.336 0 Td \
             (i) Tj 2.664 0 Td (o) Tj 6.672 0 Td (n) Tj ET",
        );
        let before = analyze_pdf_page(&pdf, 1).expect("analyse avant");
        let block = before
            .blocks
            .iter()
            .find(|b| strip_whitespace(&b.text).contains("Soflution"))
            .expect("Soflution");
        let chars: Vec<_> = block
            .chars
            .iter()
            .filter(|c| c.page_char_index >= 0)
            .collect();
        let removed = chars.iter().position(|c| c.text == "i").expect("i");
        let removed_index = chars[removed].page_char_index;
        let previous_index = chars[removed - 1].page_char_index;
        let next_index = chars[removed + 1].page_char_index;

        let outcome = crate::pdf_stream_edit::edit_pdf_text_stream(
            &pdf,
            1,
            &[removed_index as u32],
            previous_index,
            next_index,
            "",
            0.0,
            100.0,
            1.0,
            false,
        )
        .expect("la suppression doit rester native");
        let edited = outcome
            .report
            .analysis
            .blocks
            .iter()
            .find(|b| strip_whitespace(&b.text).contains("Sofluton"))
            .expect("Sofluton après suppression");
        assert_eq!(edited.font_name, block.font_name, "la police ne doit pas changer");

        // Deuxième suppression consécutive : les nouveaux indices issus de la
        // ré-analyse doivent rester utilisables, sans repli après la première.
        let edited_chars: Vec<_> = edited
            .chars
            .iter()
            .filter(|c| c.page_char_index >= 0)
            .collect();
        let removed_t = edited_chars
            .iter()
            .position(|c| c.text == "t")
            .expect("t après première suppression");
        let second = crate::pdf_stream_edit::edit_pdf_text_stream(
            &outcome.bytes,
            1,
            &[edited_chars[removed_t].page_char_index as u32],
            edited_chars[removed_t - 1].page_char_index,
            edited_chars[removed_t + 1].page_char_index,
            "",
            0.0,
            100.0,
            1.0,
            false,
        )
        .expect("la deuxième suppression doit rester native");
        assert!(
            second
                .report
                .analysis
                .blocks
                .iter()
                .any(|b| strip_whitespace(&b.text).contains("Sofluon")),
            "les suppressions successives doivent conserver l'ordre du texte"
        );
    }

    #[test]
    fn stream_edit_inserts_into_independent_glyph_objects_without_font_fallback() {
        if !pdfium_available() {
            return;
        }
        // Cas réel du reçu : chaque glyphe de « Soflution » possède son propre
        // BT/ET et sa propre matrice Tm. Insérer entre i et o doit décaler o, n
        // et toutes les continuations suivantes, sans repli HTML ni police neuve.
        let mut bytes = test_pdf_with_content(
            "BT /F1 12 Tf 1 0 0 1 20 50 Tm (S) Tj ET \
             BT /F1 12 Tf 1 0 0 1 28.004 50 Tm (o) Tj ET \
             BT /F1 12 Tf 1 0 0 1 34.676 50 Tm (f) Tj ET \
             BT /F1 12 Tf 1 0 0 1 38.012 50 Tm (l) Tj ET \
             BT /F1 12 Tf 1 0 0 1 40.676 50 Tm (u) Tj ET \
             BT /F1 12 Tf 1 0 0 1 47.348 50 Tm (t) Tj ET \
             BT /F1 12 Tf 1 0 0 1 50.684 50 Tm (i) Tj ET \
             BT /F1 12 Tf 1 0 0 1 53.348 50 Tm (o) Tj ET \
             BT /F1 12 Tf 1 0 0 1 60.020 50 Tm (n) Tj ET",
        );
        let original_font = analyze_pdf_page(&bytes, 1)
            .expect("analyse initiale")
            .blocks
            .iter()
            .find(|block| strip_whitespace(&block.text).contains("Soflution"))
            .expect("Soflution")
            .font_name
            .clone();

        for expected_l_count in 1..=5 {
            let analysis = analyze_pdf_page(&bytes, 1).expect("analyse avant frappe");
            let block = analysis
                .blocks
                .iter()
                .find(|candidate| strip_whitespace(&candidate.text).contains("Sofluti"))
                .expect("bloc Soflution");
            let anchor = if expected_l_count == 1 {
                block
                    .chars
                    .iter()
                    .find(|character| character.text == "i")
                    .expect("i")
            } else {
                block
                    .chars
                    .iter()
                    .rev()
                    .find(|character| character.text == "L")
                    .expect("dernier L")
            };
            bytes = native_edit(&bytes, &[], anchor.page_char_index, "L")
                .expect("la frappe doit rester native")
                .bytes;
            let expected = format!("Sofluti{}on", "L".repeat(expected_l_count));
            let edited = analyze_pdf_page(&bytes, 1).expect("analyse après frappe");
            let edited_block = edited
                .blocks
                .iter()
                .find(|candidate| strip_whitespace(&candidate.text).contains(&expected))
                .unwrap_or_else(|| panic!("texte attendu absent : {expected:?}"));
            assert_eq!(
                edited_block.font_name, original_font,
                "la police ne doit jamais changer"
            );
        }

        let before_delete = analyze_pdf_page(&bytes, 1).expect("analyse avant suppression");
        let block = before_delete
            .blocks
            .iter()
            .find(|candidate| strip_whitespace(&candidate.text).contains("SoflutiLLLLLon"))
            .expect("bloc avec cinq L");
        let removed_index = block
            .chars
            .iter()
            .rev()
            .find(|character| character.text == "L")
            .expect("dernier L")
            .page_char_index;
        bytes = native_edit(&bytes, &[removed_index as u32], -1, "")
            .expect("la suppression doit rester native")
            .bytes;
        let after_delete = analyze_pdf_page(&bytes, 1).expect("analyse après suppression");
        let edited = after_delete
            .blocks
            .iter()
            .find(|candidate| strip_whitespace(&candidate.text).contains("SoflutiLLLLon"))
            .expect("quatre L après suppression");
        assert_eq!(
            edited.font_name, original_font,
            "la suppression ne doit pas changer la police"
        );
    }

    #[test]
    fn analysis_keeps_dash_only_segment() {
        if !pdfium_available() {
            return;
        }
        // Un show op réduit à un tiret a une boîte de segment de ~0,8 pt de
        // haut (l'encre du trait) : le filtre anti-artefacts la jetait et le
        // « - » DISPARAISSAIT de l'analyse (cas réel : « Annexe 1 - Pièce… »
        // rescindé après une suppression). La boîte doit être reprise des
        // caractères, pas de l'encre du segment.
        let pdf = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td (Annexe 1) Tj ET \
             BT /F1 12 Tf 68 50 Td (-) Tj ET \
             BT /F1 12 Tf 75 50 Td (Suite) Tj ET",
        );
        let analysis = analyze_pdf_page(&pdf, 1).expect("analyse");
        let squeezed: String = analysis
            .blocks
            .iter()
            .flat_map(|b| b.text.chars())
            .filter(|c| !c.is_whitespace())
            .collect();
        assert!(
            squeezed.contains("Annexe1-Suite"),
            "le tiret isolé a disparu de l'analyse : {squeezed:?}"
        );
    }

    #[test]
    fn native_edit_refuses_shift_merging_identical_neighbor_glyph() {
        if !pdfium_available() {
            return;
        }
        // Ligne scindée en DEUX objets : « AB11 » puis « 1CD » positionné par
        // un Td explicite (cas réel : numéro de facture Google scindé
        // « GCFRD001 » + « 1047732 »). Insérer après « B » décale le suffixe
        // « 11 » dont le dernier « 1 » vient se superposer au « 1 » de l'objet
        // suivant, immobile : les deux glyphes fusionnent dans la page texte
        // et un chiffre du numéro DISPARAÎT à l'extraction. L'édition doit
        // être refusée (insert_collision), pas commise silencieusement.
        // Largeurs Helvetica 12pt : A/B = 8.004, 1 = 6.672, X = 8.004.
        // « AB11 » à x=20 finit à 49.352 ; après insertion du X le dernier
        // « 1 » démarre à 50.684 — le voisin est posé là.
        let pdf = test_pdf_with_content(
            "BT /F1 12 Tf 20 50 Td (AB11) Tj ET BT /F1 12 Tf 50.684 50 Td (1CD) Tj ET",
        );
        let b_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "B")
            .expect("B présent")
            .page_char_index;
        let err = match native_edit(&pdf, &[], b_index, "X") {
            Ok(_) => panic!("l'insertion qui fusionne un glyphe voisin doit être refusée"),
            Err(e) => e,
        };
        assert_eq!(err, "insert_collision", "erreur inattendue : {err}");
    }

    #[test]
    fn native_edit_accepts_accented_insert() {
        if !pdfium_available() {
            return;
        }
        // « é » existe en WinAnsi (0xE9) : l'encodage de l'insertion doit
        // passer par la table de la police, pas par l'ASCII.
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Hello World) Tj ET");
        let outcome = native_edit(&pdf, &[], 4, "é").expect("insertion accentuée acceptée");
        let text: String = outcome
            .report
            .analysis
            .blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect();
        assert!(text.contains("Helloé"), "texte réécrit : {text}");
    }

    // Frappe ancrée sur l'ESPACE GÉNÉRÉ (extraction de texte : écart de crénage
    // rendu comme espace, sans octet dans le flux). L'insertion doit tomber du
    // côté DROIT du blanc (début du run suivant), pas être recollée à gauche.
    #[test]
    fn native_edit_insert_after_generated_space_lands_right_of_gap() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td [(He) -300 (llo)] TJ ET");
        let analysis = analyze_pdf_page(&pdf, 1).expect("analyse");
        let space_index = analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == " ")
            .expect("espace généré présent dans les caractères")
            .page_char_index;
        let outcome =
            native_edit(&pdf, &[], space_index, "X").expect("insertion après espace généré");
        let after = char_lefts(&outcome.bytes);
        let text: String = after.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(text, "HeXllo", "texte final inattendu");
        // Le X appartient au run de DROITE : il démarre là où « llo »
        // commençait (après le blanc de crénage), pas collé à « He ».
        let before = char_lefts(&pdf);
        let l_before = before[2].1; // premier « l » avant édition
        let x_pos = after[2].1; // « X » inséré
        assert!(
            x_pos >= l_before - 0.5,
            "X recollé à gauche du blanc de crénage : {x_pos} < {l_before}"
        );
        // Préfixe (« He ») strictement immobile.
        for i in 0..2 {
            assert!(
                (after[i].1 - before[i].1).abs() <= 0.35,
                "préfixe déplacé : {} → {}",
                before[i].1,
                after[i].1
            );
        }
    }

    #[test]
    fn native_edit_after_inserted_space() {
        if !pdfium_available() {
            return;
        }
        // Un espace inséré à côté d'un espace existant produit DEUX codes
        // espace consécutifs dans le flux, que la page texte PDFium fusionne
        // en un seul caractère. L'aligneur codes↔caractères doit consommer le
        // code espace surnuméraire, sinon toute frappe suivante dans l'objet
        // est refusée (`code_alignment`) et bascule en HTML (bande blanche
        // coupant les tableaux côté interface).
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Hello World) Tj ET");
        let o_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("caractère o présent")
            .page_char_index;
        let with_space =
            native_edit(&pdf, &[], o_index, " ").expect("insertion d'espace acceptée");
        // Nouvelle frappe après le même « o » : le flux porte « Hello  World ».
        let o_again = analyze_pdf_page(&with_space.bytes, 1)
            .expect("ré-analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("o toujours présent")
            .page_char_index;
        let outcome = native_edit(&with_space.bytes, &[], o_again, "X")
            .expect("frappe après espace inséré acceptée");
        let text: String = outcome
            .report
            .analysis
            .blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect();
        let squeezed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(squeezed.contains("HelloXWorld"), "texte réécrit : {text}");
    }

    #[test]
    fn native_edit_replaces_complete_collapsed_space_run() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (ar) Tj ET");
        let initial = analyze_pdf_page(&pdf, 1).expect("analyse initiale");
        let a_index = initial
            .blocks
            .iter()
            .flat_map(|block| block.chars.iter())
            .find(|character| character.text == "a")
            .expect("a")
            .page_char_index;
        let four_spaces = native_edit(&pdf, &[], a_index, "    ").expect("quatre espaces");
        assert!(
            literal_page_text(&four_spaces.bytes).contains("a    r"),
            "run initial absent : {:?}",
            literal_page_text(&four_spaces.bytes)
        );

        let analysis = analyze_pdf_page(&four_spaces.bytes, 1).expect("réanalyse");
        let chars: Vec<&PdfCharBox> = analysis
            .blocks
            .iter()
            .flat_map(|block| block.chars.iter())
            .collect();
        let a_again = chars
            .iter()
            .find(|character| character.text == "a")
            .expect("a après insertion")
            .page_char_index;
        let collapsed_space = chars
            .iter()
            .find(|character| character.text.chars().all(char::is_whitespace))
            .expect("espace PDFium fusionnée")
            .page_char_index;
        let two_spaces = edit_pdf_text(
            &four_spaces.bytes,
            1,
            &[collapsed_space as u32],
            a_again,
            -1,
            "  ",
            0.0,
            100.0,
            1.0,
            None,
            None,
        )
        .expect("remplacement du run");
        assert!(
            literal_page_text(&two_spaces.bytes).contains("a  r"),
            "run remplacé incorrectement : {:?}",
            literal_page_text(&two_spaces.bytes)
        );
    }

    #[test]
    fn native_edit_replaces_hidden_trailing_space_run() {
        if !pdfium_available() {
            return;
        }
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (a) Tj ET");
        let a_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse initiale")
            .blocks
            .iter()
            .flat_map(|block| block.chars.iter())
            .find(|character| character.text == "a")
            .expect("a")
            .page_char_index;
        let four_spaces = edit_pdf_text_with_options(
            &pdf,
            1,
            &[],
            a_index,
            -1,
            "    ",
            0.0,
            100.0,
            1.0,
            None,
            None,
            true,
        )
        .expect("quatre espaces finaux");
        assert!(literal_page_text(&four_spaces.bytes).contains("a    "));

        let a_again = analyze_pdf_page(&four_spaces.bytes, 1)
            .expect("réanalyse")
            .blocks
            .iter()
            .flat_map(|block| block.chars.iter())
            .find(|character| character.text == "a")
            .expect("a après insertion")
            .page_char_index;
        let two_spaces = edit_pdf_text_with_options(
            &four_spaces.bytes,
            1,
            &[],
            a_again,
            -1,
            "  ",
            0.0,
            100.0,
            1.0,
            None,
            None,
            true,
        )
        .expect("remplacement des espaces finaux");
        let text = literal_page_text(&two_spaces.bytes);
        assert!(text.contains("a  "), "run final absent : {text:?}");
        assert!(!text.contains("a   "), "anciens espaces conservés : {text:?}");

        let followed_by_character = edit_pdf_text_with_options(
            &two_spaces.bytes,
            1,
            &[],
            a_again,
            -1,
            "  X",
            0.0,
            100.0,
            1.0,
            None,
            None,
            true,
        )
        .expect("caractère après les espaces finaux");
        assert!(
            literal_page_text(&followed_by_character.bytes).contains("a  X"),
            "le caractère ne doit pas passer avant les espaces : {:?}",
            literal_page_text(&followed_by_character.bytes)
        );

        let followed_analysis =
            analyze_pdf_page(&followed_by_character.bytes, 1).expect("réanalyse avec caractère");
        let followed_chars: Vec<&PdfCharBox> = followed_analysis
            .blocks
            .iter()
            .flat_map(|block| block.chars.iter())
            .collect();
        let followed_a = followed_chars
            .iter()
            .find(|character| character.text == "a")
            .expect("a avant le run")
            .page_char_index;
        let followed_x = followed_chars
            .iter()
            .find(|character| character.text == "X")
            .expect("X après le run")
            .page_char_index;
        let followed_space = followed_chars
            .iter()
            .find(|character| character.text.chars().all(char::is_whitespace))
            .expect("run d'espaces entre a et X")
            .page_char_index;
        let followed_space = u32::try_from(followed_space).expect("espace réel dans le flux");
        let one_space = edit_pdf_text_with_options(
            &followed_by_character.bytes,
            1,
            &[followed_space],
            followed_a,
            followed_x,
            " ",
            0.0,
            100.0,
            1.0,
            None,
            None,
            true,
        )
        .expect("suppression d'une espace du run");
        assert!(
            literal_page_text(&one_space.bytes).contains("a X"),
            "le run réduit doit conserver une espace : {:?}",
            literal_page_text(&one_space.bytes)
        );

        let without_spaces = edit_pdf_text_with_options(
            &two_spaces.bytes,
            1,
            &[],
            a_again,
            -1,
            "",
            0.0,
            100.0,
            1.0,
            None,
            None,
            true,
        )
        .expect("suppression des espaces finaux");
        assert_eq!(literal_page_text(&without_spaces.bytes), "a");
    }

    #[test]
    fn native_edit_preserves_custom_kerning() {
        if !pdfium_available() {
            return;
        }
        // Crénage personnalisé interne (écart TJ de 3,6 pt entre "He" et
        // "llo") : le splice de flux ne touche pas aux octets existants →
        // l'ajustement -300 survit et le préfixe reste immobile.
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td [(He) -300 (llo)] TJ ET");
        let before = char_lefts(&pdf);

        // Insérer "X" après le "o" final. L'index PAGE du « o » est résolu
        // dynamiquement : l'analyse peut synthétiser une espace visuelle au
        // niveau de l'écart de crénage, ce qui décale les indices.
        let o_index = analyze_pdf_page(&pdf, 1)
            .expect("analyse")
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("caractère o présent")
            .page_char_index;
        let outcome = native_edit(&pdf, &[], o_index, "X").expect("édition avec crénage acceptée");
        let text: String = outcome
            .report
            .analysis
            .blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect();
        // L'analyse peut rendre l'écart de crénage comme une espace visuelle
        // (« He lloX ») : on compare hors blancs.
        let squeezed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(squeezed.contains("HelloX"), "texte réécrit : {text}");
        let after = char_lefts(&outcome.bytes);
        for (i, (c, x_before)) in before.iter().enumerate() {
            let (_, x_after) = after[i];
            assert!(
                (x_after - x_before).abs() <= 0.35,
                "préfixe déplacé malgré le crénage : '{c}' {x_before} → {x_after}"
            );
        }
    }

    #[test]
    fn native_edit_rejects_missing_glyph() {
        if !pdfium_available() {
            return;
        }
        // Helvetica (WinAnsi) n'a pas le glyphe CJK : le moteur le jetterait
        // silencieusement → l'édition doit être refusée, document intact.
        let pdf = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Hello World) Tj ET");
        let result = native_edit(&pdf, &[], 4, "中");
        assert!(result.is_err(), "glyphe manquant accepté à tort");
    }

    #[test]
    fn native_export_returns_original_when_no_edits() {
        // Aucune page éditée (jpeg vide) ⇒ original renvoyé tel quel, sans PDFium.
        let original = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";
        let pages = vec![
            EditedPage { page_number: 1, jpeg_bytes: Vec::new(), width: 0.0, height: 0.0, strategy: None },
            EditedPage { page_number: 2, jpeg_bytes: Vec::new(), width: 0.0, height: 0.0, strategy: None },
        ];
        let out = export_edited_pdf_native(original, pages).unwrap();
        assert_eq!(out, original.to_vec());
    }

    #[test]
    fn export_strategy_preserves_native_pages() {
        let page = EditedPage {
            page_number: 1,
            jpeg_bytes: vec![1, 2, 3],
            width: 100.0,
            height: 100.0,
            strategy: Some(ExportStrategy {
                page_number: 1,
                mode: "native_preserved".to_string(),
                reason: "no_edits".to_string(),
            }),
        };
        assert!(!should_flatten_edited_page(&page));
    }

    #[test]
    fn export_strategy_flattens_vector_candidates_until_ops_exist() {
        let page = EditedPage {
            page_number: 1,
            jpeg_bytes: vec![1, 2, 3],
            width: 100.0,
            height: 100.0,
            strategy: Some(ExportStrategy {
                page_number: 1,
                mode: "vector_candidate".to_string(),
                reason: "simple_text".to_string(),
            }),
        };
        assert!(should_flatten_edited_page(&page));
    }

    #[test]
    fn vector_export_rejects_non_pdf() {
        let op = VectorTextOperation {
            page_number: 1,
            bbox: [0.0, 0.0, 10.0, 10.0],
            target_bbox: None,
            text: "Hello".to_string(),
            font: Some("helvetica".to_string()),
            font_family: None,
            bold: false,
            italic: false,
            font_bytes: None,
            size: Some(10.0),
            color: Some([0, 0, 0]),
            align: Some("left".to_string()),
            source: None,
            insert_only: false,
            reason: "replace_text".to_string(),
        };
        assert!(export_edited_pdf_vector(b"not-pdf", vec![op]).is_err());
    }

    #[test]
    fn vector_insert_only_preserves_existing_text() {
        if !pdfium_available() {
            return;
        }
        let original = test_pdf_with_content("BT /F1 12 Tf 20 50 Td (Original) Tj ET");
        let op = VectorTextOperation {
            page_number: 1,
            bbox: [20.0, 30.0, 120.0, 52.0],
            target_bbox: Some([20.0, 30.0, 120.0, 52.0]),
            text: "Added".to_string(),
            font: Some("helvetica".to_string()),
            font_family: None,
            bold: false,
            italic: false,
            font_bytes: None,
            size: Some(12.0),
            color: Some([0, 0, 0]),
            align: Some("left".to_string()),
            source: Some("added".to_string()),
            insert_only: true,
            reason: "add_text".to_string(),
        };

        let exported = export_edited_pdf_vector(&original, vec![op]).expect("export insertion");
        let text = analyze_pdf_page(&exported.bytes, 1)
            .expect("analyse")
            .blocks
            .into_iter()
            .map(|block| block.text)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(text.contains("Original"), "texte existant supprimé : {text:?}");
        assert!(text.contains("Added"), "texte ajouté absent : {text:?}");
    }

    #[test]
    fn native_edit_falls_back_to_embedded_font_for_unencodable_char() {
        if !pdfium_available() {
            return;
        }
        // Encodage restreint : le code 113 ('q') est remappé vers /space, la
        // police d'origine ne peut donc PAS encoder un 'q' inséré. L'édition
        // doit réussir via la police de secours embarquée (comportement
        // Adobe) au lieu d'être refusée.
        let bytes = test_pdf_with_font_and_content(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [113 /space] >> >>",
            "BT /F1 12 Tf 20 50 Td (Hello World) Tj ET",
        );
        let before = char_lefts(&bytes);
        let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
        let anchor = analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "o")
            .expect("premier o présent");
        let outcome = edit_pdf_text(
            &bytes,
            1,
            &[],
            anchor.page_char_index,
            -1,
            "q",
            0.0,
            100.0,
            1.0,
            Some("Helloq World"),
            None,
        )
        .expect("édition via police de secours");
        let after = char_lefts(&outcome.bytes);
        let text: String = after.iter().map(|(t, _)| t.as_str()).collect();
        assert!(
            text.contains("Helloq"),
            "le q inséré doit être extrait : {text:?}"
        );
        // Préfixe « Hello » : positions strictement inchangées.
        for i in 0..5 {
            assert_eq!(before[i].0, after[i].0, "prefixe altéré");
            assert!(
                (before[i].1 - after[i].1).abs() < 0.1,
                "le caractère {} a bougé de {} pt",
                before[i].0,
                (before[i].1 - after[i].1).abs()
            );
        }
        // La police de secours est bien EMBARQUÉE dans le document.
        assert!(
            outcome
                .bytes
                .windows(b"AltoFB-LiberationSans".len())
                .any(|w| w == b"AltoFB-LiberationSans"),
            "police de secours absente du document"
        );
    }

    #[test]
    fn native_edit_fallback_still_shifts_line_continuation() {
        if !pdfium_available() {
            return;
        }
        // Cas Revolut : un glyphe force AltoFB, puis on tape devant le fragment
        // jointif suivant (« nov »). Le décalage doit rester actif malgré le
        // fallback — sinon insert_collision et frappe bloquée.
        let bytes = test_pdf_with_font_and_content(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [113 /space] >> >>",
            "BT /F1 12 Tf 20 50 Td (du ) Tj ET \
             BT /F1 12 Tf 38 50 Td (nov) Tj ET",
        );
        let before = analyze_pdf_page(&bytes, 1).expect("analyse");
        let space = before
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == " ")
            .expect("espace après du");
        let nov_before = before
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "n")
            .expect("n de nov")
            .x;
        let outcome = edit_pdf_text(
            &bytes,
            1,
            &[],
            space.page_char_index,
            -1,
            "q",
            0.0,
            100.0,
            1.0,
            None,
            None,
        )
        .expect("insertion fallback devant continuation");
        let after = analyze_pdf_page(&outcome.bytes, 1).expect("ré-analyse");
        let text: String = after
            .blocks
            .iter()
            .flat_map(|b| b.text.chars())
            .filter(|c| !c.is_whitespace())
            .collect();
        assert!(
            text.contains("duqnov"),
            "ordre de lecture corrompu : {text:?}"
        );
        let nov_after = after
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .find(|c| c.text == "n")
            .expect("n après édition")
            .x;
        assert!(
            nov_after > nov_before + 1.0,
            "nov doit être décalé malgré AltoFB (avant={nov_before}, après={nov_after})"
        );
        assert!(
            outcome
                .bytes
                .windows(b"AltoFB-LiberationSans".len())
                .any(|w| w == b"AltoFB-LiberationSans"),
            "police de secours absente"
        );
    }

    #[test]
    fn native_edit_fallback_at_end_of_text() {
        if !pdfium_available() {
            return;
        }
        // Insertion en FIN de chaîne (suffixe vide) : la scission ne produit
        // pas de TJ suffixe — l'état de police doit quand même être restauré.
        let bytes = test_pdf_with_font_and_content(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [113 /space] >> >>",
            "BT /F1 12 Tf 20 50 Td (Hello) Tj ET BT /F1 12 Tf 150 50 Td (World) Tj ET",
        );
        let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
        let anchor = analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .filter(|c| c.text == "o")
            .min_by(|a, b| a.x.partial_cmp(&b.x).unwrap())
            .expect("o de Hello");
        let before = char_lefts(&bytes);
        let outcome = edit_pdf_text(
            &bytes,
            1,
            &[],
            anchor.page_char_index,
            -1,
            "q",
            0.0,
            100.0,
            1.0,
            Some("Helloq"),
            None,
        )
        .expect("édition via police de secours en fin de chaîne");
        let after = char_lefts(&outcome.bytes);
        let text: String = after.iter().map(|(t, _)| t.as_str()).collect();
        assert!(text.contains("Helloq"), "q final absent : {text:?}");
        // « World » (objet suivant) : positions inchangées — l'état de police
        // restauré après l'insertion ne doit pas altérer son rendu.
        let world_before: Vec<&(String, f64)> =
            before.iter().filter(|(_, x)| *x > 140.0).collect();
        let world_after: Vec<&(String, f64)> =
            after.iter().filter(|(_, x)| *x > 140.0).collect();
        assert_eq!(world_before.len(), world_after.len());
        for (b, a) in world_before.iter().zip(world_after.iter()) {
            assert_eq!(b.0, a.0);
            assert!((b.1 - a.1).abs() < 0.1, "World a bougé");
        }
    }

    #[test]
    fn adjacent_show_ops_do_not_gain_phantom_space() {
        if !pdfium_available() {
            return;
        }
        // Régression (facture « Soflution ») : un mot scindé en deux show-ops
        // jointifs (« Sof » + « lution ») gagnait un espace fantôme parce que
        // l'écart était mesuré sur les BOÎTES DE SEGMENTS (plus larges que
        // leurs glyphes), affichant « Sof lution » et décalant l'édition.
        // L'écart doit être mesuré sur les caractères : ici il vaut 0.
        // Largeurs Helvetica 12pt : S=8.004 o=6.672 f=3.336 → « Sof » = 18.012.
        let bytes = test_pdf_with_font_and_content(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "BT /F1 12 Tf 20 50 Td (Sof) Tj ET BT /F1 12 Tf 38.012 50 Td (lution) Tj ET",
        );
        let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
        let block = analysis
            .blocks
            .iter()
            .find(|b| b.text.contains("lution"))
            .expect("bloc Soflution");
        assert_eq!(
            block.text, "Soflution",
            "espace fantôme entre deux show-ops jointifs"
        );
        let from_chars: String = block.chars.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(from_chars, block.text, "texte ↔ caractères désalignés");
    }

    #[test]
    fn typing_after_fallback_glyph_stays_in_order() {
        if !pdfium_available() {
            return;
        }
        // Régression : après l'insertion d'un glyphe en POLICE DE SECOURS
        // (Tj séparé dans le flux), une frappe ancrée derrière lui doit
        // 1) apparaître APRÈS lui dans l'ordre de lecture, et 2) laisser le
        // bloc d'analyse aligné texte ↔ caractères. Le bug historique : le
        // re-tri (y, x) des caractères au niveau paragraphe déplaçait le
        // glyphe de secours (hauteur atypique), l'ancre se résolvait sur le
        // caractère précédent et la frappe s'insérait AVANT lui (« wq »).
        let bytes = test_pdf_with_font_and_content(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [113 /space] >> >>",
            "BT /F1 12 Tf 20 50 Td (Hello) Tj ET",
        );
        // Frappe 1 : « q » inencodable → police de secours.
        let analysis = analyze_pdf_page(&bytes, 1).expect("analyse");
        let anchor = analysis
            .blocks
            .iter()
            .flat_map(|b| b.chars.iter())
            .filter(|c| c.text == "o")
            .min_by(|a, b| a.x.partial_cmp(&b.x).unwrap())
            .expect("o de Hello");
        let outcome = edit_pdf_text(
            &bytes,
            1,
            &[],
            anchor.page_char_index,
            -1,
            "q",
            0.0,
            100.0,
            1.0,
            Some("Helloq"),
            None,
        )
        .expect("insertion q via police de secours");
        // Frappe 2 : « w » (encodable) ancrée APRÈS le q de secours.
        let re = analyze_pdf_page(&outcome.bytes, 1).expect("ré-analyse");
        let block = re
            .blocks
            .iter()
            .find(|b| b.text.contains("Helloq"))
            .expect("bloc Helloq après la première frappe");
        // Alignement texte ↔ caractères préservé malgré le glyphe de secours.
        let from_chars: String = block.chars.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(from_chars, block.text, "bloc désaligné après fallback");
        let q_anchor = block
            .chars
            .iter()
            .find(|c| c.text == "q")
            .expect("q dans les caractères du bloc");
        let outcome2 = edit_pdf_text(
            &outcome.bytes,
            1,
            &[],
            q_anchor.page_char_index,
            -1,
            "w",
            0.0,
            100.0,
            1.0,
            Some("Helloqw"),
            None,
        )
        .expect("frappe après le glyphe de secours");
        let final_analysis = analyze_pdf_page(&outcome2.bytes, 1).expect("analyse finale");
        let final_block = final_analysis
            .blocks
            .iter()
            .find(|b| b.text.contains("Hello"))
            .expect("bloc final");
        assert!(
            final_block.text.contains("Helloqw"),
            "ordre de frappe perdu : {:?}",
            final_block.text
        );
    }

    #[test]
    fn vector_export_returns_original_with_no_operations() {
        let original = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";
        let out = export_edited_pdf_vector(original, Vec::new()).unwrap();
        assert_eq!(out.applied, 0);
        assert!(out.warnings.is_empty());
        assert_eq!(out.bytes, original.to_vec());
    }

    #[test]
    fn vector_text_operation_accepts_ocr_target_bbox_payload() {
        let op: VectorTextOperation = serde_json::from_value(serde_json::json!({
            "pageNumber": 2,
            "bbox": [10.0, 20.0, 80.0, 36.0],
            "targetBbox": [30.0, 42.0, 110.0, 60.0],
            "text": "Edited OCR",
            "font": "helvetica",
            "size": 12.0,
            "color": [17, 17, 17],
            "align": "left",
            "source": "ocr",
            "reason": "replace_text"
        }))
        .unwrap();
        assert_eq!(op.page_number, 2);
        assert_eq!(op.source.as_deref(), Some("ocr"));
        assert_eq!(op.target_bbox, Some([30.0, 42.0, 110.0, 60.0]));
    }

    #[test]
    fn classify_document_detects_invoice() {
        let (kind, confidence) = classify_document_text("Facture\nTotal HT\nTVA\nTotal TTC\nSIRET");
        assert_eq!(kind, "invoice");
        assert!(confidence >= 70.0);
    }

    #[test]
    fn classify_document_stays_other_for_plain_text() {
        let (kind, confidence) = classify_document_text("Bonjour ceci est une note libre sans montant.");
        assert_eq!(kind, "other");
        assert_eq!(confidence, 0.0);
    }

    #[test]
    fn detect_field_kind_identifies_critical_fields() {
        assert_eq!(detect_field_kind("Total TTC 1 234,56 EUR", "invoice"), Some("total"));
        assert_eq!(detect_field_kind("TVA 20%", "invoice"), Some("tax"));
        assert_eq!(detect_field_kind("IBAN FR76 3000 6000 0112 3456 7890 189", "invoice"), Some("iban"));
        assert!(is_critical_field("iban"));
    }
}
