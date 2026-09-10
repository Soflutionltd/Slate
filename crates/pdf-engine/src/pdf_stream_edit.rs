//! Édition de texte par SPLICE du flux de contenu (étape 2 — « façon Adobe »).
//!
//! `FPDFText_SetText` ré-encode l'objet texte entier avec les avances par
//! défaut de la police : tout crénage personnalisé (justification, tableaux)
//! et tout saut de colonne interne (rangées de tableau émises en un seul TJ)
//! sont détruits — d'où les refus `layout_divergence` / `multi_column_object`
//! et le repli HTML (police de substitution, micro-mouvement).
//!
//! Ici, on modifie CHIRURGICALEMENT les octets de l'opérateur `Tj`/`TJ` dans
//! le flux de contenu : les caractères non touchés gardent leurs octets ET
//! leurs ajustements de position d'origine. Pour les objets multi-colonnes,
//! le décalage induit par l'édition est COMPENSÉ par un ajustement TJ inséré
//! à la frontière de colonne : les colonnes suivantes ne bougent pas d'un
//! micron (comportement Adobe).
//!
//! La validation est le même contrôle de fidélité positionnel que le chemin
//! `set_text` : texte exact, préfixe immobile, suffixe de colonne décalé d'un
//! delta uniforme, colonnes suivantes immobiles. Tout écart rejette l'édition
//! (le document original reste intact, l'appelant tente `set_text` puis HTML).

use crate::pdf_engine::{
    analyze_pdf_page, base64_encode, pdfium_guard, strip_whitespace, NativeTextEditOutcome,
    NativeTextEditReport,
};
use lopdf::content::{Content, Operation};
use lopdf::{Document, Object};
use pdfium_render::prelude::*;
use std::collections::BTreeSet;

const POSITION_TOLERANCE_PT: f64 = 0.35;
/// Tolérance d'immobilité des colonnes suivantes (légèrement plus large : la
/// compensation empirique converge en 1-2 passes à ~0,1 pt près).
const COLUMN_TOLERANCE_PT: f64 = 0.5;

// ─── Localisation (PDFium, lecture seule) ────────────────────────────────────

struct LocatedObject {
    /// Ordinal de l'objet cible PARMI les objets TEXTE de la page (l'ordre des
    /// objets texte PDFium suit l'ordre des opérateurs Tj/TJ du flux).
    text_ordinal: usize,
    /// Caractères de l'objet : (index page texte, unicode, left pt, bottom pt).
    chars: Vec<(i64, char, f64, f64)>,
    /// Taille de police EFFECTIVE (matrice comprise) : convertit points ↔
    /// unités TJ (millièmes de cadratin).
    scaled_font_size: f64,
    /// Frontières de colonnes : ordinal i tel qu'un saut de colonne sépare les
    /// caractères i et i+1.
    column_breaks: Vec<usize>,
    /// Largeur de la page en points (borne d'élargissement des clips).
    page_width: f64,
    /// Nom de la police de l'objet (PDFium) : sert à choisir le STYLE de la
    /// police de secours quand un glyphe inséré manque.
    font_name: String,
    /// Bord droit original de l'objet, utilisé pour mesurer sa croissance
    /// après insertion (donc le décalage à transmettre à la suite de ligne).
    object_left: f64,
    object_right: f64,
    /// Prochain objet texte quasi jointif sur la même ligne de base.
    /// Certains générateurs émettent un `Tj` par GLYPHE dans un même `BT…ET`.
    /// L'analyse les regroupe en une phrase, mais une insertion dans un `Tj`
    /// ne décale pas le `Tj` suivant : on doit transmettre la croissance au
    /// `Td` relatif qui les sépare.
    continuation: Option<LineContinuation>,
    /// Toutes les continuations jointives de la ligne, pas uniquement la
    /// première. Certaines polices sont émises avec un `BT/ET` distinct par
    /// glyphe : chacune doit alors recevoir le même décalage.
    continuations: Vec<LineContinuation>,
}

#[derive(Clone, Copy)]
struct LineContinuation {
    text_ordinal: usize,
    left: f64,
    right: f64,
    bottom: f64,
}

fn locate_object(
    page: &PdfPage,
    anchor_indices: &[i64],
) -> Result<LocatedObject, String> {
    let text = page.text().map_err(|e| e.to_string())?;
    let all_chars = text.chars();
    let mut anchor_rects: Vec<(f64, f64, f64, f64)> = Vec::new();
    for &idx in anchor_indices {
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

    let mut found: Option<LocatedObject> = None;
    // Bornes de l'objet cible (points page) pour la recherche de continuation.
    let mut own_bounds: Option<(f64, f64, f64, f64)> = None; // (l, b, r, t)
    let mut text_ordinal = 0usize;
    for object in page.objects().iter() {
        let Some(text_obj) = object.as_text_object() else {
            continue;
        };
        let ordinal = text_ordinal;
        text_ordinal += 1;
        if found.is_some() {
            continue;
        }
        if !anchor_rects.is_empty() {
            let Ok(bounds) = object.bounds() else {
                continue;
            };
            let ol = bounds.left().value as f64 - 2.0;
            let ob = bounds.bottom().value as f64 - 2.0;
            let or = bounds.right().value as f64 + 2.0;
            let ot = bounds.top().value as f64 + 2.0;
            let touches = anchor_rects
                .iter()
                .any(|&(l, b, r, t)| l < or && r > ol && b < ot && t > ob);
            if !touches {
                continue;
            }
        }
        let chars = text.chars_for_object(text_obj).map_err(|e| e.to_string())?;
        let indices: BTreeSet<i64> = chars.iter().map(|c| c.index() as i64).collect();
        let holds_all = anchor_indices.iter().all(|i| indices.contains(i));
        if !holds_all {
            if anchor_indices.iter().any(|i| indices.contains(i)) {
                return Err("multi_object_edit".to_string());
            }
            continue;
        }
        let mut mapped = Vec::new();
        let mut min_left = f64::MAX;
        let mut max_right = f64::MIN;
        let mut min_bottom = f64::MAX;
        let mut max_top = f64::MIN;
        let mut max_height = 0.0f64;
        let mut last_idx = i64::MIN;
        for c in chars.iter() {
            let Some(u) = c.unicode_char() else {
                return Err("unmapped_glyph".to_string());
            };
            let idx = c.index() as i64;
            if idx <= last_idx {
                return Err("unordered_object".to_string());
            }
            last_idx = idx;
            let (left, bottom) = match c.loose_bounds() {
                Ok(rect) => {
                    // Bornes horizontales sur les glyphes VISIBLES : la boîte
                    // loose d'une espace de fin s'étend jusqu'au run suivant
                    // et masquerait une continuation jointive.
                    if !u.is_whitespace() {
                        min_left = min_left.min(rect.left().value as f64);
                        max_right = max_right.max(rect.right().value as f64);
                    }
                    min_bottom = min_bottom.min(rect.bottom().value as f64);
                    max_top = max_top.max(rect.top().value as f64);
                    max_height = max_height.max(rect.height().value as f64);
                    (rect.left().value as f64, rect.bottom().value as f64)
                }
                Err(_) => (f64::NAN, f64::NAN),
            };
            mapped.push((idx, u, left, bottom));
        }
        if max_height > 0.0 && (max_top - min_bottom) > max_height * 1.8 {
            return Err("multi_line_object".to_string());
        }
        // Frontières de colonnes (autorisées ici, contrairement à set_text) :
        // même détection que le chemin natif, mais on les MÉMORISE pour la
        // compensation au lieu de refuser l'édition.
        let gap_threshold = max_height.max(4.0) * 1.5;
        let mut column_breaks = Vec::new();
        for (i, pair) in mapped.windows(2).enumerate() {
            let (_, prev_u, prev_left, _) = pair[0];
            let (_, _, next_left, _) = pair[1];
            if prev_left.is_nan() || next_left.is_nan() {
                continue;
            }
            let advance_allowance = if prev_u == ' ' { max_height } else { max_height * 1.2 };
            if next_left - prev_left > gap_threshold + advance_allowance {
                column_breaks.push(i);
            }
        }
        let scaled_font_size = {
            let size = text_obj.scaled_font_size().value as f64;
            if size > 0.1 { size } else { 12.0 }
        };
        if min_bottom < max_top && min_left < max_right {
            own_bounds = Some((min_left, min_bottom, max_right, max_top));
        }
        found = Some(LocatedObject {
            text_ordinal: ordinal,
            chars: mapped,
            scaled_font_size,
            column_breaks,
            page_width: page.width().value as f64,
            font_name: text_obj.font().name(),
            object_left: min_left,
            object_right: max_right,
            continuation: None,
            continuations: Vec::new(),
        });
    }
    let mut located = found.ok_or_else(|| "text_object_not_found".to_string())?;

    // Continuation de ligne : la même ligne visuelle est souvent scindée en
    // plusieurs objets quasi jointifs (« Calvi, le 16 » + « mai 2026, »).
    // Ces objets ne bougent pas quand notre suffixe se décale : mémoriser le
    // bord gauche du plus proche pour refuser tout débordement (l'ordre de
    // lecture serait corrompu). Un voisin LOINTAIN (vraie colonne de tableau)
    // n'est pas une continuation : chevauchement toléré, le frontend gère la
    // fusion de blocs.
    if let Some((_own_left, own_bottom, own_right, own_top)) = own_bounds {
        let proximity = (own_top - own_bottom).max(4.0) * 1.5;
        let mut candidates: Vec<(LineContinuation, f64)> = Vec::new();
        let mut ordinal = 0usize;
        for object in page.objects().iter() {
            let Some(_) = object.as_text_object() else {
                continue;
            };
            let current = ordinal;
            ordinal += 1;
            if current <= located.text_ordinal {
                continue;
            }
            let Ok(bounds) = object.bounds() else {
                continue;
            };
            let left = bounds.left().value as f64;
            let right = bounds.right().value as f64;
            let bottom = bounds.bottom().value as f64;
            let top = bounds.top().value as f64;
            // Même ligne de base (recouvrement vertical majoritaire), à droite
            // de notre objet, à moins d'une hauteur et demie de ligne.
            let overlap = own_top.min(top) - own_bottom.max(bottom);
            if overlap < (own_top - own_bottom).min(top - bottom) * 0.5 {
                continue;
            }
            if right <= own_right - 1.0 {
                continue;
            }
            candidates.push((
                LineContinuation {
                    text_ordinal: current,
                    left,
                    right,
                    bottom,
                },
                top,
            ));
        }
        candidates.sort_by(|(a, _), (b, _)| {
            a.left
                .partial_cmp(&b.left)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut edge = own_right;
        for (candidate, _top) in candidates {
            // On construit une chaîne visuelle continue. Le premier vrai saut
            // de colonne arrête la propagation : il ne doit jamais être déplacé.
            if candidate.left - edge > proximity {
                break;
            }
            if candidate.left < edge - 2.0 {
                continue;
            }
            if candidate.right <= edge - 1.0 {
                continue;
            }
            edge = edge.max(candidate.right);
            located.continuations.push(candidate);
        }
        located.continuation = located.continuations.first().copied();
    }
    Ok(located)
}

// ─── Plan d'édition en ordinaux d'objet ──────────────────────────────────────

struct EditPlan {
    /// Ordinaux (dans l'objet) des caractères supprimés.
    removed_ordinals: BTreeSet<usize>,
    /// Position d'insertion (ordinal du premier caractère du suffixe) ;
    /// usize::MAX si aucune insertion.
    insert_ordinal: usize,
    /// L'insertion est ancrée « après » le caractère précédent (fin de la
    /// colonne éditée) plutôt qu'« avant » le suivant (début de la colonne
    /// suivante) — la différence compte quand l'insertion tombe pile sur un
    /// saut de colonne.
    insert_anchored_after: bool,
    /// Frontière de compensation : ordinal du DERNIER caractère de la colonne
    /// éditée (un saut de colonne le sépare du suivant). None = pas de colonne
    /// après le point d'édition.
    comp_break: Option<usize>,
    /// Texte attendu après édition, blancs retirés.
    expected: String,
    /// Positions des caractères CONSERVÉS, dans l'ordre, avec classification :
    /// (left, bottom, unicode, classe).
    kept: Vec<(f64, f64, char, KeptClass)>,
    inserted_nonws_count: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum KeptClass {
    Prefix,
    SameColumn,
    LaterColumns,
}

fn build_plan(
    located: &LocatedObject,
    removed: &BTreeSet<i64>,
    insert_after: i64,
    insert_before: i64,
    inserted: &str,
    soft_anchors: &BTreeSet<i64>,
    replace_whitespace_run: bool,
) -> Result<EditPlan, String> {
    let ordinal_of = |page_idx: i64| -> Option<usize> {
        located.chars.iter().position(|&(idx, ..)| idx == page_idx)
    };
    // Premier caractère de l'objet STRICTEMENT après un index page donné :
    // résout les ancres posées sur un espace GÉNÉRÉ par l'extraction de texte
    // (écart de crénage/colonne rendu comme espace : aucun octet, absent de
    // l'objet). Taper « après » cet espace = taper AVANT le caractère réel
    // suivant ; le supprimer = no-op (il n'existe pas dans le document).
    let ordinal_after = |page_idx: i64| -> Option<usize> {
        located.chars.iter().position(|&(idx, ..)| idx > page_idx)
    };
    let mut removed_ordinals = BTreeSet::new();
    for &idx in removed {
        match ordinal_of(idx) {
            Some(o) => {
                removed_ordinals.insert(o);
            }
            None if soft_anchors.contains(&idx) => {}
            None => return Err("removed_char_not_in_object".to_string()),
        }
    }
    let mut insert_anchored_after = false;
    let insert_ordinal = if inserted.is_empty() && !replace_whitespace_run {
        usize::MAX
    } else if insert_before >= 0 {
        match ordinal_of(insert_before) {
            Some(o) => o,
            None if soft_anchors.contains(&insert_before) => {
                // « Avant » un espace généré = après le caractère réel précédent.
                match ordinal_after(insert_before) {
                    Some(o) if o > 0 => {
                        insert_anchored_after = true;
                        o
                    }
                    Some(o) => o,
                    None => {
                        insert_anchored_after = true;
                        located.chars.len()
                    }
                }
            }
            None => return Err("anchor_not_in_object".to_string()),
        }
    } else if insert_after >= 0 {
        match ordinal_of(insert_after) {
            Some(o) => {
                insert_anchored_after = true;
                o + 1
            }
            None if soft_anchors.contains(&insert_after) => {
                // « Après » un espace généré = avant le caractère réel suivant.
                match ordinal_after(insert_after) {
                    Some(o) => o,
                    None => {
                        insert_anchored_after = true;
                        located.chars.len()
                    }
                }
            }
            None => return Err("anchor_not_in_object".to_string()),
        }
    } else {
        insert_anchored_after = true;
        located.chars.len()
    };
    // Point d'ancrage de la COMPENSATION : le premier endroit du texte touché
    // par l'édition. Une insertion ancrée « après » appartient à la colonne du
    // caractère précédent (insert_ordinal − 1) ; ancrée « avant », à celle du
    // caractère suivant (insert_ordinal).
    let insert_anchor_point = if insert_ordinal == usize::MAX {
        None
    } else if insert_anchored_after {
        Some(insert_ordinal.saturating_sub(1))
    } else {
        Some(insert_ordinal)
    };
    let comp_anchor = match (removed_ordinals.iter().next(), insert_anchor_point) {
        (Some(&r), Some(i)) => r.min(i),
        (Some(&r), None) => r,
        (None, Some(i)) => i,
        (None, None) => return Err("empty_edit".to_string()),
    };
    // Frontière de compensation : premier saut de colonne à partir du point
    // d'ancrage (les colonnes situées APRÈS ce saut ne doivent pas bouger).
    let comp_break = located
        .column_breaks
        .iter()
        .copied()
        .find(|&b| b >= comp_anchor);
    // Édition à cheval sur un saut de colonne : hors périmètre (le frontend
    // édite une cellule à la fois, ce cas signale un mapping incohérent).
    if let Some(b) = comp_break {
        if removed_ordinals.iter().any(|&o| o > b) {
            return Err("cross_column_edit".to_string());
        }
    }
    // Premier ordinal du suffixe (classification préfixe/suffixe).
    let edit_point = match (removed_ordinals.iter().next(), insert_ordinal) {
        (Some(&r), usize::MAX) => r,
        (Some(&r), i) => r.min(i),
        (None, _) => insert_ordinal,
    };

    let mut expected = String::new();
    let mut kept = Vec::new();
    for (ordinal, &(_, u, left, bottom)) in located.chars.iter().enumerate() {
        if ordinal == insert_ordinal {
            expected.push_str(inserted);
        }
        if removed_ordinals.contains(&ordinal) {
            continue;
        }
        expected.push(u);
        let class = if ordinal < edit_point {
            KeptClass::Prefix
        } else if comp_break.map(|b| ordinal > b).unwrap_or(false) {
            KeptClass::LaterColumns
        } else {
            KeptClass::SameColumn
        };
        kept.push((left, bottom, u, class));
    }
    if insert_ordinal != usize::MAX && insert_ordinal >= located.chars.len() {
        expected.push_str(inserted);
    }
    Ok(EditPlan {
        removed_ordinals,
        insert_ordinal,
        insert_anchored_after,
        comp_break,
        expected: strip_whitespace(&expected),
        kept,
        inserted_nonws_count: inserted.chars().filter(|c| !c.is_whitespace()).count(),
    })
}

// ─── Splice lopdf du flux de contenu ─────────────────────────────────────────

/// Élément d'un opérateur de texte : chaîne (octets bruts) ou nombre TJ.
#[derive(Clone)]
enum TextElem {
    Str(Vec<u8>),
    Num(f64),
}

/// Un code caractère du flux : élément, plage d'octets, unicode décodé.
struct StreamCode {
    elem: usize,
    start: usize,
    len: usize,
    unicode: Vec<char>,
}

fn decode_codes(
    elements: &[TextElem],
    encoding: &lopdf::Encoding<'_>,
) -> Result<Vec<StreamCode>, String> {
    use lopdf::Encoding as Enc;
    let mut codes = Vec::new();
    for (elem_idx, elem) in elements.iter().enumerate() {
        let TextElem::Str(bytes) = elem else { continue };
        match encoding {
            Enc::OneByteEncoding(map) => {
                for (i, &b) in bytes.iter().enumerate() {
                    let unicode = map[b as usize]
                        .and_then(|cp| char::from_u32(cp as u32))
                        .map(|c| vec![c])
                        .unwrap_or_default();
                    codes.push(StreamCode { elem: elem_idx, start: i, len: 1, unicode });
                }
            }
            Enc::UnicodeMapEncoding(cmap) => {
                // Même algorithme glouton que lopdf (codes de 1 à 4 octets),
                // mais en mémorisant la PLAGE D'OCTETS de chaque code.
                let mut start = 0usize;
                let mut code_len = 0u8;
                let mut code_val = 0u32;
                for (i, &b) in bytes.iter().enumerate() {
                    if code_len == 0 {
                        start = i;
                    }
                    code_len += 1;
                    code_val = code_val * 256 + b as u32;
                    if let Some(units) = cmap.get(code_val, code_len) {
                        let unicode = char::decode_utf16(units.iter().copied())
                            .collect::<Result<Vec<char>, _>>()
                            .unwrap_or_default();
                        codes.push(StreamCode {
                            elem: elem_idx,
                            start,
                            len: code_len as usize,
                            unicode,
                        });
                        code_len = 0;
                        code_val = 0;
                    } else if code_len == 4 {
                        // Code inconnu du CMap : on le garde comme code opaque
                        // (aucun unicode) — l'alignement échouera s'il compte.
                        codes.push(StreamCode {
                            elem: elem_idx,
                            start,
                            len: 4,
                            unicode: Vec::new(),
                        });
                        code_len = 0;
                        code_val = 0;
                    }
                }
                if code_len > 0 {
                    codes.push(StreamCode {
                        elem: elem_idx,
                        start,
                        len: code_len as usize,
                        unicode: Vec::new(),
                    });
                }
            }
            _ => return Err("unsupported_encoding".to_string()),
        }
    }
    Ok(codes)
}

/// Aligne les caractères de l'objet PDFium (qui peuvent contenir des espaces
/// SYNTHÉTIQUES absents du flux) sur les codes du flux. Retourne, pour chaque
/// ordinal d'objet, l'index du code correspondant (None = synthétique).
fn align_codes(
    obj_chars: &[(i64, char, f64, f64)],
    codes: &[StreamCode],
) -> Result<Vec<Option<usize>>, String> {
    let mut assign = Vec::with_capacity(obj_chars.len());
    let mut ci = 0usize;
    for &(_, u, ..) in obj_chars {
        if ci < codes.len() && codes[ci].unicode.first() == Some(&u) && codes[ci].unicode.len() == 1 {
            assign.push(Some(ci));
            ci += 1;
            continue;
        }
        // Codes BLANCS du flux non exposés par le text page : PDFium fusionne
        // les espaces consécutifs (« Solde␣␣à » → un seul espace après une
        // insertion d'espace). On les consomme sans ordinal, sinon l'aligneur
        // bute sur le caractère suivant.
        while ci < codes.len()
            && !codes[ci].unicode.is_empty()
            && codes[ci].unicode.iter().all(|c| c.is_whitespace())
            && codes[ci].unicode.first() != Some(&u)
        {
            ci += 1;
        }
        if ci < codes.len() && codes[ci].unicode.first() == Some(&u) && codes[ci].unicode.len() == 1 {
            assign.push(Some(ci));
            ci += 1;
            continue;
        }
        if u.is_whitespace() {
            // Espace synthétique du text page (grand blanc entre colonnes) :
            // aucun octet correspondant dans le flux.
            assign.push(None);
            continue;
        }
        if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
            let obj_str: String = obj_chars.iter().map(|&(_, c, ..)| c).collect();
            let codes_str: String = codes
                .iter()
                .map(|c| c.unicode.iter().collect::<String>())
                .collect();
            eprintln!(
                "[stream-debug] code_alignment char={u:?} ci={ci} obj={obj_str:?} codes={codes_str:?}"
            );
        }
        return Err("code_alignment".to_string());
    }
    // Codes restants non consommés : tolérés uniquement s'ils sont des blancs
    // (espaces réels de fin non exposés par le text page).
    for code in &codes[ci..] {
        let is_ws = code.unicode.iter().all(|c| c.is_whitespace()) && !code.unicode.is_empty();
        if !is_ws {
            return Err("code_alignment".to_string());
        }
    }
    Ok(assign)
}

/// Applique le splice au flux de contenu et renvoie le document complet.
/// `comp_units` ≠ 0 insère un ajustement TJ à la frontière de colonne.
#[allow(clippy::too_many_arguments)]
/// Clips actifs au moment où l'opérateur cible peint son texte. Les clips
/// « simples » (chemin composé d'un unique `re`) sont élargissables ; tout
/// autre chemin de découpe est marqué complexe (jamais modifié).
struct ClipInfo {
    /// Bord droit le plus contraignant parmi les clips simples actifs.
    min_right: Option<f64>,
    /// Au moins un clip actif n'est pas un rectangle unique.
    complex: bool,
    /// Bord gauche (espace page) du premier fill BLANC perçable peint APRÈS le
    /// texte édité et recouvrant sa bande verticale : du texte qui s'étend
    /// au-delà serait recouvert (invisible) → l'appelant re-splice avec
    /// `punch_holes_to` pour percer ces fonds.
    cover_left: Option<f64>,
    /// Bord gauche du premier recouvrement NON perçable (fill coloré, chemin
    /// complexe, fill+trait) : du texte au-delà est refusé (`covered_insert`).
    cover_blocked_left: Option<f64>,
    /// La continuation de ligne est reliée par un `Td` relatif dans le même
    /// objet texte : son suffixe peut être décalé sans reconstruire la ligne.
    fragment_shift_supported: bool,
}

#[derive(Clone, Copy)]
struct FragmentShiftTarget {
    op_idx: usize,
    operand_idx: usize,
    scale_x: f64,
}

/// Matrice de transformation courante (CTM), suivie à travers `q`/`Q`/`cm`.
/// Les opérandes de `re` sont en espace LOCAL : sans cette conversion, les
/// comparaisons avec les positions page de PDFium sont fausses dès que le
/// contenu est mis à l'échelle (ex. flux entier sous `0.12 0 0 0.12 0 0 cm`).
#[derive(Clone, Copy)]
struct Ctm {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Ctm {
    fn identity() -> Self {
        Ctm { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 }
    }
    /// CTM' = M × CTM (l'opérateur `cm` pré-concatène sa matrice).
    fn concat(&self, m: &Ctm) -> Ctm {
        Ctm {
            a: m.a * self.a + m.b * self.c,
            b: m.a * self.b + m.b * self.d,
            c: m.c * self.a + m.d * self.c,
            d: m.c * self.b + m.d * self.d,
            e: m.e * self.a + m.f * self.c + self.e,
            f: m.e * self.b + m.f * self.d + self.f,
        }
    }
    fn is_axis_aligned(&self) -> bool {
        self.b.abs() < 1e-9 && self.c.abs() < 1e-9 && self.a.abs() > 1e-9 && self.d.abs() > 1e-9
    }
}

/// Rectangle `re` suivi : coordonnées converties en espace page (normalisées,
/// w/h ≥ 0) + échelles/translations pour ré-écrire les opérandes locaux.
#[derive(Clone, Copy)]
struct TrackedRect {
    op_idx: usize,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale_x: f64,
    scale_y: f64,
    trans_x: f64,
    trans_y: f64,
}

impl TrackedRect {
    fn from_local(op_idx: usize, nums: &[f64], ctm: &Ctm) -> Option<TrackedRect> {
        if !ctm.is_axis_aligned() || ctm.a < 0.0 || ctm.d < 0.0 {
            return None;
        }
        let (lx, ly, lw, lh) = (nums[0], nums[1], nums[2], nums[3]);
        let x0 = ctm.a * lx + ctm.e;
        let y0 = ctm.d * ly + ctm.f;
        let x1 = ctm.a * (lx + lw) + ctm.e;
        let y1 = ctm.d * (ly + lh) + ctm.f;
        Some(TrackedRect {
            op_idx,
            x: x0.min(x1),
            y: y0.min(y1),
            w: (x1 - x0).abs(),
            h: (y1 - y0).abs(),
            scale_x: ctm.a,
            scale_y: ctm.d,
            trans_x: ctm.e,
            trans_y: ctm.f,
        })
    }
    /// Convertit un rectangle page (x, y, w, h) vers les opérandes locaux.
    fn to_local(&self, px: f64, py: f64, pw: f64, ph: f64) -> [f64; 4] {
        [
            (px - self.trans_x) / self.scale_x,
            (py - self.trans_y) / self.scale_y,
            pw / self.scale_x,
            ph / self.scale_y,
        ]
    }
}

/// Fill rectangulaire peint APRÈS le texte édité (candidat au perçage).
struct LaterFill {
    rects: Vec<TrackedRect>,
    /// Blanc pur ET chemin simple ET opérateur fill pur → perçable.
    punchable: bool,
}

#[allow(clippy::too_many_arguments)]
fn splice_content(
    bytes: &[u8],
    page_number: u32,
    located: &LocatedObject,
    plan: &EditPlan,
    inserted: &str,
    replace_whitespace_run: bool,
    comp_units: f64,
    fragment_shift_pt: f64,
    widen_clip_right_to: Option<f64>,
    punch_holes_to: Option<f64>,
    fallback: Option<crate::pdf_fallback_font::FallbackStyle>,
) -> Result<(Vec<u8>, ClipInfo), String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("lopdf: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted_document".to_string());
    }
    let pages = doc.get_pages();
    let page_id = *pages
        .get(&page_number)
        .ok_or_else(|| "page_not_found".to_string())?;
    // Police de secours (glyphe manquant dans la police d'origine) : embarquée
    // dans le document et enregistrée dans les ressources de la page AVANT le
    // décodage du flux — les deux opérations sont indépendantes.
    let fallback_font: Option<(Vec<u8>, Vec<u8>)> = match fallback {
        None => None,
        Some(style) => {
            if inserted.is_empty() {
                return Err("fallback_without_insert".to_string());
            }
            let encoded = crate::pdf_fallback_font::winansi_encode(inserted)
                .ok_or_else(|| "unencodable_insert".to_string())?;
            let resource_name =
                crate::pdf_fallback_font::ensure_page_fallback_font(&mut doc, page_id, style)?;
            Some((resource_name, encoded))
        }
    };
    let content_data = doc
        .get_page_content(page_id)
        .map_err(|e| format!("lopdf content: {e}"))?;
    // Images inline (BI…EI) : lopdf les ré-encoderait en syntaxe invalide, et
    // JETTE silencieusement celles qu'il ne sait pas parser — le ré-encodage
    // du flux entier corromprait la page. Détection sur les octets BRUTS
    // (l'opération peut avoir disparu du parse) : token « BI » délimité.
    // Faux positif possible dans des données littérales → simple repli set_text.
    let has_inline_image = content_data.windows(3).enumerate().any(|(i, w)| {
        w[0] == b'B'
            && w[1] == b'I'
            && (w[2] == b' ' || w[2] == b'\n' || w[2] == b'\r' || w[2] == b'\t' || w[2] == b'/')
            && (i == 0 || {
                let p = content_data[i - 1];
                p == b' ' || p == b'\n' || p == b'\r' || p == b'\t'
            })
    });
    if has_inline_image {
        return Err("inline_image_unsupported".to_string());
    }
    let mut content =
        Content::decode(&content_data).map_err(|e| format!("lopdf decode: {e}"))?;
    if content
        .operations
        .iter()
        .any(|op| op.operands.iter().any(|o| matches!(o, Object::Stream(_))))
    {
        return Err("inline_image_unsupported".to_string());
    }

    // 1) Trouver l'opérateur de texte cible (ordinal parmi Tj/TJ/'/") en
    //    suivant la police courante (Tf), avec pile q/Q. On suit AUSSI les
    //    chemins de découpe actifs (`re … W n`) : c'est le clip de cellule qui
    //    tronque le texte quand une insertion le fait déborder — on doit
    //    pouvoir l'élargir (comportement Adobe).
    let num_of = |o: &Object| -> Option<f64> {
        match o {
            Object::Integer(i) => Some(*i as f64),
            Object::Real(f) => Some(*f as f64),
            _ => None,
        }
    };
    // Police courante : (nom de ressource, taille Tf en unités LOCALES) — la
    // taille est nécessaire pour ré-émettre un Tf identique autour d'une
    // insertion en police de secours.
    let mut current_font: Option<(Vec<u8>, f64)> = None;
    let mut font_stack: Vec<Option<(Vec<u8>, f64)>> = Vec::new();
    // CTM courante + couleur de fill courante ((r,g,b) 0..1, None = inconnue),
    // empilées avec q/Q.
    let mut ctm = Ctm::identity();
    let mut ctm_stack: Vec<Ctm> = Vec::new();
    let mut fill_color: Option<(f64, f64, f64)> = Some((0.0, 0.0, 0.0));
    let mut fill_color_stack: Vec<Option<(f64, f64, f64)>> = Vec::new();
    // Clip actif : Some(rect page) si rectangle unique axis-aligned, None sinon
    // (jamais élargi).
    let mut active_clips: Vec<Option<TrackedRect>> = Vec::new();
    let mut clip_stack: Vec<usize> = Vec::new();
    let mut path_re: Vec<Option<TrackedRect>> = Vec::new();
    let mut path_complex = false;
    let mut pending_clip = false;
    let mut show_ordinal = 0usize;
    let mut target_op: Option<(usize, (Vec<u8>, f64))> = None;
    let mut target_clips: Vec<Option<TrackedRect>> = Vec::new();
    // Fills peints APRÈS l'opérateur de texte cible (candidats recouvrement).
    let mut later_fills: Vec<LaterFill> = Vec::new();
    for (op_idx, op) in content.operations.iter().enumerate() {
        match op.operator.as_str() {
            "q" => {
                font_stack.push(current_font.clone());
                clip_stack.push(active_clips.len());
                ctm_stack.push(ctm);
                fill_color_stack.push(fill_color);
            }
            "Q" => {
                if let Some(f) = font_stack.pop() {
                    current_font = f;
                }
                if let Some(n) = clip_stack.pop() {
                    active_clips.truncate(n);
                }
                if let Some(m) = ctm_stack.pop() {
                    ctm = m;
                }
                if let Some(col) = fill_color_stack.pop() {
                    fill_color = col;
                }
            }
            "cm" => {
                let nums: Vec<f64> = op.operands.iter().filter_map(num_of).collect();
                if nums.len() == 6 {
                    let m = Ctm {
                        a: nums[0],
                        b: nums[1],
                        c: nums[2],
                        d: nums[3],
                        e: nums[4],
                        f: nums[5],
                    };
                    ctm = ctm.concat(&m);
                }
            }
            "rg" => {
                let nums: Vec<f64> = op.operands.iter().filter_map(num_of).collect();
                fill_color = (nums.len() == 3).then(|| (nums[0], nums[1], nums[2]));
            }
            "g" => {
                let nums: Vec<f64> = op.operands.iter().filter_map(num_of).collect();
                fill_color = (nums.len() == 1).then(|| (nums[0], nums[0], nums[0]));
            }
            "k" => {
                let nums: Vec<f64> = op.operands.iter().filter_map(num_of).collect();
                fill_color = (nums.len() == 4).then(|| {
                    let (c, m, y, kk) = (nums[0], nums[1], nums[2], nums[3]);
                    ((1.0 - c) * (1.0 - kk), (1.0 - m) * (1.0 - kk), (1.0 - y) * (1.0 - kk))
                });
            }
            // Espaces de couleur nommés / séparations : couleur inconnue.
            "cs" | "sc" | "scn" => fill_color = None,
            "Tf" => {
                if let Some(Object::Name(name)) = op.operands.first() {
                    let size = op.operands.get(1).and_then(num_of).unwrap_or(12.0);
                    current_font = Some((name.clone(), size));
                }
            }
            "re" => {
                let nums: Vec<f64> = op.operands.iter().filter_map(num_of).collect();
                if nums.len() == 4 {
                    let tracked = TrackedRect::from_local(op_idx, &nums, &ctm);
                    if tracked.is_none() {
                        path_complex = true;
                    }
                    path_re.push(tracked);
                } else {
                    path_complex = true;
                }
            }
            "m" | "l" | "c" | "v" | "y" | "h" => path_complex = true,
            "W" | "W*" => pending_clip = true,
            "n" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "S" | "s" => {
                if pending_clip {
                    active_clips.push(if !path_complex && path_re.len() == 1 {
                        path_re[0]
                    } else {
                        None
                    });
                    pending_clip = false;
                }
                // Fill peint après le texte cible : candidat au recouvrement.
                // Un fill BLANC PUR à chemin rectangulaire simple est perçable
                // (blanc sur fond blanc : retirer la zone du texte est
                // invisible). Tout le reste (couleur, chemin complexe,
                // fill+trait B/b) est bloquant.
                let operator = op.operator.as_str();
                let is_fillish = matches!(operator, "f" | "F" | "f*" | "B" | "B*" | "b" | "b*");
                if is_fillish && target_op.is_some() && !path_re.is_empty() {
                    let is_white = fill_color
                        .map(|(r, g, b)| r >= 0.999 && g >= 0.999 && b >= 0.999)
                        .unwrap_or(false);
                    let simple = !path_complex && path_re.iter().all(|r| r.is_some());
                    let pure_fill = matches!(operator, "f" | "F" | "f*");
                    later_fills.push(LaterFill {
                        rects: path_re.iter().flatten().copied().collect(),
                        punchable: is_white && simple && pure_fill,
                    });
                }
                path_re.clear();
                path_complex = false;
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if target_op.is_none() && show_ordinal == located.text_ordinal {
                    let font = current_font
                        .clone()
                        .ok_or_else(|| "no_current_font".to_string())?;
                    target_op = Some((op_idx, font));
                    target_clips = active_clips.clone();
                }
                show_ordinal += 1;
            }
            _ => {}
        }
    }
    let (op_idx, (font_name, font_size)) =
        target_op.ok_or_else(|| "show_op_not_found".to_string())?;
    let operator = content.operations[op_idx].operator.clone();

    // Familles fragmentées :
    // - plusieurs Tj dans le même BT : un seul Td relatif décalé propage la
    //   translation à tout le suffixe ;
    // - un BT/ET (souvent un Tm) par glyphe : chaque matrice indépendante doit
    //   recevoir exactement la même translation.
    let continuation_ordinals: BTreeSet<usize> = located
        .continuations
        .iter()
        .map(|continuation| continuation.text_ordinal)
        .collect();
    let mut fragment_shift_targets: Vec<FragmentShiftTarget> = Vec::new();
    let mut shift_ctm = Ctm::identity();
    let mut shift_ctm_stack: Vec<Ctm> = Vec::new();
    let mut shift_text_matrix_a = 1.0f64;
    let mut shift_show_ordinal = 0usize;
    let mut shows_in_bt = 0usize;
    let mut bt_base_shifted = false;
    let mut last_position: Option<(usize, usize, f64, bool)> = None;
    let mut last_show_op: Option<usize> = None;
    for (idx, operation) in content.operations.iter().enumerate() {
        match operation.operator.as_str() {
            "q" => shift_ctm_stack.push(shift_ctm),
            "Q" => {
                if let Some(saved) = shift_ctm_stack.pop() {
                    shift_ctm = saved;
                }
            }
            "cm" => {
                let nums: Vec<f64> = operation.operands.iter().filter_map(num_of).collect();
                if nums.len() == 6 {
                    shift_ctm = shift_ctm.concat(&Ctm {
                        a: nums[0],
                        b: nums[1],
                        c: nums[2],
                        d: nums[3],
                        e: nums[4],
                        f: nums[5],
                    });
                }
            }
            "BT" => {
                shift_text_matrix_a = 1.0;
                shows_in_bt = 0;
                bt_base_shifted = false;
                last_position = None;
                last_show_op = None;
            }
            "Tm" => {
                let nums: Vec<f64> = operation.operands.iter().filter_map(num_of).collect();
                if nums.len() == 6 && shift_ctm.is_axis_aligned() {
                    shift_text_matrix_a = nums[0];
                    last_position = Some((idx, 4, shift_ctm.a.abs(), true));
                } else {
                    last_position = None;
                }
            }
            "Td" | "TD" => {
                let scale_x = (shift_ctm.a * shift_text_matrix_a).abs();
                if scale_x > 1e-9 && operation.operands.first().and_then(num_of).is_some() {
                    last_position = Some((idx, 0, scale_x, false));
                } else {
                    last_position = None;
                }
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if continuation_ordinals.contains(&shift_show_ordinal) {
                    let fresh_position = last_position.filter(|(position_idx, _, _, _)| {
                        last_show_op.map_or(true, |show_idx| *position_idx > show_idx)
                    });
                    if let Some((position_idx, operand_idx, scale_x, absolute)) = fresh_position {
                        // Un Tm réinitialise la matrice : il faut toujours le
                        // décaler. Un Td relatif n'est modifié qu'une fois par BT.
                        if absolute || shows_in_bt == 0 || !bt_base_shifted {
                            fragment_shift_targets.push(FragmentShiftTarget {
                                op_idx: position_idx,
                                operand_idx,
                                scale_x,
                            });
                            bt_base_shifted = true;
                        }
                    }
                }
                shows_in_bt += 1;
                last_show_op = Some(idx);
                shift_show_ordinal += 1;
            }
            "ET" => {
                last_position = None;
                last_show_op = None;
            }
            _ => {}
        }
    }
    fragment_shift_targets.sort_by_key(|target| target.op_idx);
    fragment_shift_targets.dedup_by_key(|target| (target.op_idx, target.operand_idx));
    // Le décalage des fragments suivants doit rester actif même quand la
    // frappe passe par AltoFB (police de secours) : sinon, dès qu'un glyphe
    // a déjà forcé le fallback (ex. « 6 »), toute insertion devant le
    // fragment jointif (« nov ») est refusée en insert_collision et la
    // frappe semble bloquée.
    let fragment_shift_supported = !fragment_shift_targets.is_empty();

    // 2) Extraire les éléments (chaînes / nombres TJ) de l'opérateur.
    let string_operand_index = if operator == "\"" { 2 } else { 0 };
    let mut elements: Vec<TextElem> = Vec::new();
    match operator.as_str() {
        "Tj" | "'" | "\"" => {
            let Some(Object::String(bytes, _)) =
                content.operations[op_idx].operands.get(string_operand_index)
            else {
                return Err("unexpected_operand".to_string());
            };
            elements.push(TextElem::Str(bytes.clone()));
        }
        "TJ" => {
            let Some(Object::Array(items)) = content.operations[op_idx].operands.first() else {
                return Err("unexpected_operand".to_string());
            };
            for item in items {
                match item {
                    Object::String(bytes, _) => elements.push(TextElem::Str(bytes.clone())),
                    Object::Integer(i) => elements.push(TextElem::Num(*i as f64)),
                    Object::Real(f) => elements.push(TextElem::Num(*f as f64)),
                    _ => return Err("unexpected_operand".to_string()),
                }
            }
        }
        _ => unreachable!(),
    }

    // 3) Décoder les codes avec l'encodage de la police, encoder l'insertion.
    //    Portée dédiée : l'encodage emprunte `doc` (dictionnaire de police),
    //    qui doit être relâché avant la réécriture du flux.
    let (codes, inserted_bytes) = {
        let fonts = doc
            .get_page_fonts(page_id)
            .map_err(|e| format!("lopdf fonts: {e}"))?;
        let font_dict = fonts
            .get(&font_name)
            .ok_or_else(|| "font_not_found".to_string())?;
        let encoding = font_dict
            .get_font_encoding(&doc)
            .map_err(|_| "unsupported_encoding".to_string())?;
        let codes = decode_codes(&elements, &encoding)?;
        // Encodage du texte inséré, avec vérification aller-retour STRICTE
        // (string_to_bytes jette silencieusement les caractères inencodables).
        // Police de secours : les octets insérés sont encodés en WinAnsi et
        // émis dans un Tj SÉPARÉ (voir étape 7) — rien n'est épissé ici.
        let inserted_bytes: Vec<u8> = if inserted.is_empty() || fallback_font.is_some() {
            Vec::new()
        } else {
            let out = encoding.string_to_bytes(inserted);
            let round_trip = encoding.bytes_to_string(&out).unwrap_or_default();
            if round_trip != inserted {
                return Err("unencodable_insert".to_string());
            }
            out
        };
        (codes, inserted_bytes)
    };
    let assign = align_codes(&located.chars, &codes)?;

    // 5) Positions d'édition dans (élément, octet).
    // Début du code du premier ordinal ≥ demandé qui possède un code.
    let position_at_start = |ordinal: usize| -> Option<(usize, usize)> {
        for o in ordinal..located.chars.len() {
            if let Some(ci) = assign[o] {
                return Some((codes[ci].elem, codes[ci].start));
            }
        }
        None
    };
    // Fin du code du dernier ordinal ≤ demandé qui possède un code.
    let position_at_end = |ordinal: usize| -> Option<(usize, usize)> {
        for o in (0..=ordinal.min(located.chars.len().saturating_sub(1))).rev() {
            if let Some(ci) = assign[o] {
                return Some((codes[ci].elem, codes[ci].start + codes[ci].len));
            }
        }
        None
    };
    // L'insertion doit tomber du BON CÔTÉ des caractères synthétiques (espaces
    // générés par l'extraction de texte au niveau d'un écart de crénage ou de
    // colonne : ils n'ont AUCUN octet dans le flux). Ancrée « après » un
    // synthétique, elle appartient au run SUIVANT (début du prochain code
    // réel) ; ancrée « avant » un synthétique, au run PRÉCÉDENT (fin du code
    // réel précédent). Sinon le texte tapé apparaîtrait de l'autre côté du
    // blanc visuel.
    let (insert_pos, insert_before_comp) = if inserted.is_empty() && !replace_whitespace_run {
        (None, false)
    } else if plan.insert_anchored_after {
        let anchor = plan.insert_ordinal.checked_sub(1);
        let anchor_code = anchor.and_then(|o| assign.get(o).copied().flatten());
        match anchor_code {
            Some(ci) => (
                Some((codes[ci].elem, codes[ci].start + codes[ci].len)),
                true,
            ),
            None => (
                Some(
                    position_at_start(plan.insert_ordinal)
                        .or_else(|| anchor.and_then(position_at_end))
                        .ok_or_else(|| "insert_position_not_found".to_string())?,
                ),
                false,
            ),
        }
    } else {
        let anchor_code = assign.get(plan.insert_ordinal).copied().flatten();
        match anchor_code {
            Some(ci) => (Some((codes[ci].elem, codes[ci].start)), false),
            None => (
                Some(
                    position_at_end(plan.insert_ordinal.saturating_sub(1))
                        .or_else(|| position_at_start(plan.insert_ordinal))
                        .ok_or_else(|| "insert_position_not_found".to_string())?,
                ),
                true,
            ),
        }
    };
    // Compensation : entre le dernier caractère de la colonne éditée et le
    // premier caractère de la colonne suivante.
    let comp_pos = if comp_units.abs() > f64::EPSILON {
        let b = plan.comp_break.ok_or_else(|| "no_column_break".to_string())?;
        if operator != "TJ" && operator != "Tj" {
            // ' et " portent des effets de bord (T*, espacements) : convertir
            // en TJ changerait la sémantique. Trop rare pour être supporté.
            return Err("quote_op_unsupported".to_string());
        }
        Some(
            position_at_end(b)
                .ok_or_else(|| "comp_position_not_found".to_string())?,
        )
    } else {
        None
    };

    // 6) Reconstruire les éléments : suppressions, insertion, scission de
    //    compensation. Toutes les positions se réfèrent aux octets D'ORIGINE.
    let mut removed_code_indices = BTreeSet::new();
    for &ordinal in &plan.removed_ordinals {
        if let Some(ci) = assign[ordinal] {
            removed_code_indices.insert(ci);
            if located.chars[ordinal].1.is_whitespace() {
                // PDFium fusionne les espaces consécutifs en un seul caractère.
                // Remplacer ce caractère doit donc retirer TOUT le run blanc du
                // flux, sinon les octets invisibles s'accumulent à chaque frappe.
                let mut before = ci;
                while before > 0
                    && !codes[before - 1].unicode.is_empty()
                    && codes[before - 1].unicode.iter().all(|c| c.is_whitespace())
                {
                    before -= 1;
                    removed_code_indices.insert(before);
                }
                let mut after = ci + 1;
                while after < codes.len()
                    && !codes[after].unicode.is_empty()
                    && codes[after].unicode.iter().all(|c| c.is_whitespace())
                {
                    removed_code_indices.insert(after);
                    after += 1;
                }
            }
        }
        // Caractère synthétique supprimé : aucun octet à retirer.
    }
    if replace_whitespace_run && inserted.chars().all(char::is_whitespace) {
        if let Some((insert_elem, insert_byte)) = insert_pos {
            let seed = codes.iter().position(|code| {
                code.elem == insert_elem
                    && !code.unicode.is_empty()
                    && code.unicode.iter().all(|c| c.is_whitespace())
                    && (code.start == insert_byte || code.start + code.len == insert_byte)
            });
            if let Some(seed) = seed {
                removed_code_indices.insert(seed);
                let mut before = seed;
                while before > 0 {
                    let previous = &codes[before - 1];
                    let current = &codes[before];
                    if previous.elem != current.elem
                        || previous.start + previous.len != current.start
                        || previous.unicode.is_empty()
                        || !previous.unicode.iter().all(|c| c.is_whitespace())
                    {
                        break;
                    }
                    before -= 1;
                    removed_code_indices.insert(before);
                }
                let mut after = seed + 1;
                while after < codes.len() {
                    let previous = &codes[after - 1];
                    let current = &codes[after];
                    if previous.elem != current.elem
                        || previous.start + previous.len != current.start
                        || current.unicode.is_empty()
                        || !current.unicode.iter().all(|c| c.is_whitespace())
                    {
                        break;
                    }
                    removed_code_indices.insert(after);
                    after += 1;
                }
            }
        }
    }
    let removed_ranges: Vec<(usize, usize, usize)> = removed_code_indices
        .into_iter()
        .map(|ci| (codes[ci].elem, codes[ci].start, codes[ci].len))
        .collect(); // (elem, start, len)

    let mut new_elements: Vec<TextElem> = Vec::new();
    for (elem_idx, elem) in elements.iter().enumerate() {
        match elem {
            TextElem::Num(n) => new_elements.push(TextElem::Num(*n)),
            TextElem::Str(bytes) => {
                let mut out = Vec::with_capacity(bytes.len() + inserted_bytes.len());
                let mut i = 0usize;
                while i <= bytes.len() {
                    let insert_here = insert_pos == Some((elem_idx, i));
                    let comp_here = comp_pos == Some((elem_idx, i));
                    // Police de secours : le point d'insertion est matérialisé
                    // par un MARQUEUR (Num NaN) — l'étape 7 scinde l'opérateur
                    // à cet endroit pour émettre un Tj en police de secours.
                    if insert_here && insert_before_comp {
                        if fallback_font.is_some() {
                            new_elements.push(TextElem::Str(std::mem::take(&mut out)));
                            new_elements.push(TextElem::Num(f64::NAN));
                        } else {
                            out.extend_from_slice(&inserted_bytes);
                        }
                    }
                    if comp_here {
                        new_elements.push(TextElem::Str(std::mem::take(&mut out)));
                        new_elements.push(TextElem::Num(comp_units));
                    }
                    if insert_here && !insert_before_comp {
                        if fallback_font.is_some() {
                            new_elements.push(TextElem::Str(std::mem::take(&mut out)));
                            new_elements.push(TextElem::Num(f64::NAN));
                        } else {
                            out.extend_from_slice(&inserted_bytes);
                        }
                    }
                    if i == bytes.len() {
                        break;
                    }
                    let removed_here = removed_ranges
                        .iter()
                        .find(|&&(e, s, _)| e == elem_idx && s == i)
                        .map(|&(_, _, len)| len);
                    if let Some(len) = removed_here {
                        i += len;
                        continue;
                    }
                    out.push(bytes[i]);
                    i += 1;
                }
                new_elements.push(TextElem::Str(out));
            }
        }
    }

    // 7) Ré-émettre l'opérateur. Tj devient TJ si une compensation a scindé la
    //    chaîne ; sinon l'opérateur d'origine est conservé à l'identique.
    //    Police de secours : l'opérateur est SCINDÉ au point d'insertion —
    //    [préfixe] Tf secours, Tj(inséré), Tf origine, [suffixe] — les show
    //    ops successifs avancent naturellement la matrice texte, la géométrie
    //    du préfixe/suffixe est donc strictement préservée.
    let build_items = |elems: &[TextElem]| -> Vec<Object> {
        let mut items: Vec<Object> = Vec::new();
        for elem in elems {
            match elem {
                TextElem::Str(bytes) => {
                    if !bytes.is_empty() || elems.len() == 1 {
                        items.push(Object::String(
                            bytes.clone(),
                            lopdf::StringFormat::Literal,
                        ));
                    }
                }
                TextElem::Num(n) => items.push(Object::Real(*n as f32)),
            }
        }
        if items.is_empty() {
            items.push(Object::String(Vec::new(), lopdf::StringFormat::Literal));
        }
        items
    };
    let inserted_ops_delta: usize;
    if let Some((fb_name, fb_bytes)) = &fallback_font {
        if operator == "'" || operator == "\"" {
            return Err("quote_op_unsupported".to_string());
        }
        let marker = new_elements
            .iter()
            .position(|e| matches!(e, TextElem::Num(n) if n.is_nan()))
            .ok_or_else(|| "fallback_marker_missing".to_string())?;
        let before = &new_elements[..marker];
        let after = &new_elements[marker + 1..];
        let has_content = |elems: &[TextElem]| {
            elems.iter().any(|e| match e {
                TextElem::Str(b) => !b.is_empty(),
                TextElem::Num(_) => true,
            })
        };
        let mut ops: Vec<Operation> = Vec::new();
        if has_content(before) {
            ops.push(Operation::new("TJ", vec![Object::Array(build_items(before))]));
        }
        ops.push(Operation::new(
            "Tf",
            vec![
                Object::Name(fb_name.clone()),
                Object::Real(font_size as f32),
            ],
        ));
        ops.push(Operation::new(
            "Tj",
            vec![Object::String(fb_bytes.clone(), lopdf::StringFormat::Literal)],
        ));
        // Restauration de la police d'origine : les opérateurs SUIVANTS du
        // flux comptent sur l'état de police courant.
        ops.push(Operation::new(
            "Tf",
            vec![Object::Name(font_name.clone()), Object::Real(font_size as f32)],
        ));
        if has_content(after) {
            ops.push(Operation::new("TJ", vec![Object::Array(build_items(after))]));
        }
        inserted_ops_delta = ops.len() - 1;
        let mut ops_iter = ops.into_iter();
        content.operations[op_idx] = ops_iter.next().unwrap();
        for (offset, op) in ops_iter.enumerate() {
            content.operations.insert(op_idx + 1 + offset, op);
        }
    } else {
        let rebuilt = build_items(&new_elements);
        let needs_array = operator == "TJ" || rebuilt.len() > 1;
        if needs_array && (operator == "'" || operator == "\"") {
            return Err("quote_op_unsupported".to_string());
        }
        let new_op = if needs_array {
            Operation::new("TJ", vec![Object::Array(rebuilt)])
        } else {
            let mut operands = content.operations[op_idx].operands.clone();
            operands[string_operand_index] = rebuilt.into_iter().next().unwrap();
            Operation::new(operator.as_str(), operands)
        };
        content.operations[op_idx] = new_op;
        inserted_ops_delta = 0;
    }
    // Les indices d'opérations mémorisés pendant le scan (clips à élargir,
    // fills à percer) situés APRÈS l'opérateur cible sont décalés par la
    // scission.
    if inserted_ops_delta > 0 {
        for clip in target_clips.iter_mut().flatten() {
            if clip.op_idx > op_idx {
                clip.op_idx += inserted_ops_delta;
            }
        }
        for fill in later_fills.iter_mut() {
            for rect in fill.rects.iter_mut() {
                if rect.op_idx > op_idx {
                    rect.op_idx += inserted_ops_delta;
                }
            }
        }
    }
    if fragment_shift_pt.abs() > POSITION_TOLERANCE_PT {
        if fragment_shift_targets.is_empty() {
            return Err("fragmented_line_unsupported".to_string());
        }
        if fallback_font.is_some() {
            return Err("fragmented_fallback_unsupported".to_string());
        }
        for target in &fragment_shift_targets {
            let shifted_idx = if target.op_idx > op_idx {
                target.op_idx + inserted_ops_delta
            } else {
                target.op_idx
            };
            let operand = content.operations[shifted_idx]
                .operands
                .get_mut(target.operand_idx)
                .ok_or_else(|| "fragment_shift_operand".to_string())?;
            let current = num_of(operand).ok_or_else(|| "fragment_shift_operand".to_string())?;
            *operand = Object::Real((current + fragment_shift_pt / target.scale_x) as f32);
        }
    }

    // 8) Élargissement des clips (texte débordant sa cellule) : chaque clip
    //    rectangulaire actif dont le bord droit tronquerait le texte est élargi
    //    jusqu'à la largeur demandée (bornée à la page). Les clips complexes ne
    //    sont JAMAIS modifiés : si l'un d'eux tronque, l'appelant rejette.
    //    Seuls comptent les clips qui recouvrent VERTICALEMENT la ligne éditée
    //    (un clip d'une autre zone de la page ne tronque pas ce texte).
    let line_bottom = located
        .chars
        .iter()
        .map(|&(.., b)| b)
        .filter(|b| !b.is_nan())
        .fold(f64::INFINITY, f64::min);
    let line_top = line_bottom + located.scaled_font_size.max(1.0);
    let line_left = located
        .chars
        .iter()
        .map(|&(_, _, l, _)| l)
        .filter(|l| !l.is_nan())
        .fold(f64::INFINITY, f64::min);
    let clip_relevant = |r: &TrackedRect| -> bool {
        line_bottom.is_finite()
            && r.y < line_top
            && r.y + r.h > line_bottom
            && r.x <= line_left + 1.0
            && r.x + r.w > line_left
    };
    let complex_clip = target_clips.iter().any(|c| c.is_none());
    let mut widened: Vec<(usize, f64)> = Vec::new(); // (op_idx, nouveau w LOCAL)
    if let Some(target_right) = widen_clip_right_to {
        if complex_clip {
            return Err("clipped_insert".to_string());
        }
        let capped = target_right.min(located.page_width - 0.5);
        for clip in target_clips.iter().flatten() {
            if !clip_relevant(clip) || clip.x + clip.w >= capped {
                continue;
            }
            let local = clip.to_local(clip.x, clip.y, capped - clip.x, clip.h);
            widened.push((clip.op_idx, local[2]));
        }
    }
    let mut min_right: Option<f64> = None;
    for clip in target_clips.iter().flatten() {
        if !clip_relevant(clip) {
            continue;
        }
        // Bord droit EFFECTIF (après élargissement éventuel).
        let right = widened
            .iter()
            .find(|&&(idx, _)| idx == clip.op_idx)
            .map(|&(_, local_w)| clip.x + local_w * clip.scale_x)
            .unwrap_or(clip.x + clip.w);
        min_right = Some(min_right.map_or(right, |r: f64| r.min(right)));
    }
    for &(clip_op_idx, local_w) in &widened {
        if let Some(operand) = content.operations[clip_op_idx].operands.get_mut(2) {
            *operand = Object::Real(local_w as f32);
        }
    }

    // Recouvrement par des fills peints APRÈS le texte (fonds de cellules
    // voisines) : la bande verticale de la ligne éditée est concernée dès que
    // le fill s'étend à droite du début du texte. `cover_left` (perçable) et
    // `cover_blocked_left` (non perçable) remontent à l'appelant, qui compare
    // au bord droit RÉEL de l'objet après vérification PDFium.
    let fill_relevant = |r: &TrackedRect| -> bool {
        line_bottom.is_finite()
            && r.y < line_top
            && r.y + r.h > line_bottom
            && r.x + r.w > line_left + 0.5
    };
    let mut cover_left: Option<f64> = None;
    let mut cover_blocked_left: Option<f64> = None;
    for fill in &later_fills {
        for rect in &fill.rects {
            if !fill_relevant(rect) {
                continue;
            }
            let left = rect.x.max(line_left);
            let slot = if fill.punchable {
                &mut cover_left
            } else {
                &mut cover_blocked_left
            };
            *slot = Some(slot.map_or(left, |v: f64| v.min(left)));
        }
    }

    // Perçage : retirer la bande du texte des fills blancs recouvrants, en
    // découpant chaque rectangle en ≤ 4 rectangles épargnant le trou (blanc
    // sur fond blanc : invisible). Insertion d'opérations → on traite les
    // `re` par index DÉCROISSANT pour ne pas invalider les indices suivants.
    if let Some(punch_right) = punch_holes_to {
        let hole_left = line_left - 0.5;
        let hole_right = punch_right.min(located.page_width);
        let pad = (located.scaled_font_size * 0.25).max(0.75);
        let hole_bottom = line_bottom - pad;
        let hole_top = line_top + pad;
        let mut punches: Vec<(TrackedRect, Vec<[f64; 4]>)> = Vec::new();
        for fill in &later_fills {
            for rect in &fill.rects {
                if !fill_relevant(rect) || rect.x >= hole_right {
                    continue;
                }
                if !fill.punchable {
                    return Err("covered_insert".to_string());
                }
                // Intersection trou ∩ fill (espace page).
                let ix0 = hole_left.max(rect.x);
                let ix1 = hole_right.min(rect.x + rect.w);
                let iy0 = hole_bottom.max(rect.y);
                let iy1 = hole_top.min(rect.y + rect.h);
                if ix1 <= ix0 || iy1 <= iy0 {
                    continue;
                }
                // Bandes restantes : bas / haut (pleine largeur), gauche / droite.
                let mut parts: Vec<[f64; 4]> = Vec::new();
                if iy0 > rect.y {
                    parts.push([rect.x, rect.y, rect.w, iy0 - rect.y]);
                }
                if iy1 < rect.y + rect.h {
                    parts.push([rect.x, iy1, rect.w, rect.y + rect.h - iy1]);
                }
                if ix0 > rect.x {
                    parts.push([rect.x, iy0, ix0 - rect.x, iy1 - iy0]);
                }
                if ix1 < rect.x + rect.w {
                    parts.push([ix1, iy0, rect.x + rect.w - ix1, iy1 - iy0]);
                }
                punches.push((*rect, parts));
            }
        }
        punches.sort_by(|a, b| b.0.op_idx.cmp(&a.0.op_idx));
        for (rect, parts) in punches {
            let local_parts: Vec<[f64; 4]> = parts
                .iter()
                .map(|&[px, py, pw, ph]| rect.to_local(px, py, pw, ph))
                .collect();
            let make_op = |vals: &[f64; 4]| {
                Operation::new(
                    "re",
                    vals.iter().map(|&v| Object::Real(v as f32)).collect(),
                )
            };
            match local_parts.split_first() {
                None => {
                    // Fill entièrement dans le trou : rectangle vide (aucun pixel).
                    content.operations[rect.op_idx] =
                        make_op(&rect.to_local(rect.x, rect.y, 0.0, 0.0));
                }
                Some((first, others)) => {
                    content.operations[rect.op_idx] = make_op(first);
                    for (offset, vals) in others.iter().enumerate() {
                        content
                            .operations
                            .insert(rect.op_idx + 1 + offset, make_op(vals));
                    }
                }
            }
        }
    }

    let encoded = content.encode().map_err(|e| format!("lopdf encode: {e}"))?;
    doc.change_page_content(page_id, encoded)
        .map_err(|e| format!("lopdf write: {e}"))?;
    let mut out = Vec::new();
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("lopdf save: {e}"))?;
    Ok((
        out,
        ClipInfo {
            min_right,
            complex: complex_clip,
            cover_left,
            cover_blocked_left,
            fragment_shift_supported,
        },
    ))
}

// ─── Vérification de fidélité (PDFium) ───────────────────────────────────────

/// Résultat de la vérification : `column_shift` est le décalage résiduel des
/// colonnes suivantes (None si l'objet n'en a pas ou si elles sont immobiles) ;
/// `object_right` est le bord droit du caractère le plus à droite de l'objet
/// (compare au bord des clips actifs pour détecter une troncature).
struct FidelityOutcome {
    column_shift: Option<f64>,
    /// Correction (points page) à transmettre au premier `Td` de la suite de
    /// ligne fragmentée. `None` quand elle est déjà à la position attendue.
    fragment_shift: Option<f64>,
    object_right: f64,
    /// Rects (left, bottom, right, top) des glyphes INSÉRÉS non blancs — pour
    /// le contrôle de visibilité pixel (texte recouvert par un fond).
    inserted_rects: Vec<(f64, f64, f64, f64)>,
    /// Couleur de remplissage du texte suffisamment sombre pour que le contrôle
    /// pixel soit fiable (du texte clair sur fond clair est ignoré).
    text_is_dark: bool,
}

fn verify_fidelity(
    page: &PdfPage,
    located: &LocatedObject,
    plan: &EditPlan,
    expected_page_nonws: Option<usize>,
) -> Result<FidelityOutcome, String> {
    let text = page.text().map_err(|e| e.to_string())?;
    // Une insertion en POLICE DE SECOURS scinde l'opérateur cible en 2-3 show
    // ops — donc 2-3 objets texte PDFium consécutifs. On accumule les objets à
    // partir de l'ordinal cible jusqu'à couvrir exactement le texte attendu
    // (cas nominal : un seul objet suffit).
    let mut ordinal = 0usize;
    let mut text_is_dark = false;
    let mut found = false;
    let mut acc = String::new();
    // Comparaison sur les caractères NON-BLANCS uniquement : les espaces
    // synthétiques du text page (sauts de colonnes) n'ont pas d'octets dans le
    // flux et leur nombre peut varier entre l'avant et l'après.
    let mut new_positions: Vec<(f64, f64, char)> = Vec::new();
    let mut new_rects: Vec<Option<(f64, f64, f64, f64)>> = Vec::new();
    let mut object_right = 0.0f64;
    // Index page des caractères appartenant aux objets vérifiés : sert au
    // contrôle de collision (le texte inséré ne doit pas recouvrir les
    // glyphes des AUTRES objets de la page).
    let mut own_indices: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    for object in page.objects().iter() {
        let Some(text_obj) = object.as_text_object() else {
            continue;
        };
        let current = ordinal;
        ordinal += 1;
        if current < located.text_ordinal {
            continue;
        }
        if current == located.text_ordinal {
            text_is_dark = object
                .fill_color()
                .map(|c| {
                    let lum = 0.299 * c.red() as f64
                        + 0.587 * c.green() as f64
                        + 0.114 * c.blue() as f64;
                    lum < 170.0
                })
                .unwrap_or(false);
            if plan.expected.is_empty() {
                let actual = strip_whitespace(&text.for_object(text_obj));
                if actual.is_empty() {
                    return Ok(FidelityOutcome {
                        column_shift: None,
                        fragment_shift: None,
                        object_right: located.object_left,
                        inserted_rects: Vec::new(),
                        text_is_dark,
                    });
                }
                // Un Tj devenu vide disparaît de la liste des objets PDFium :
                // l'objet situé à l'ancien ordinal cible est donc désormais sa
                // continuation. Vérifier le compte global empêche d'accepter la
                // suppression du mauvais glyphe, puis mesurer le décalage à
                // transmettre au premier Td relatif.
                let Some(cont) = located.continuation else {
                    return Err("missing_glyphs".to_string());
                };
                if cont.text_ordinal != located.text_ordinal + 1 {
                    return Err("missing_glyphs".to_string());
                }
                if let Some(expected_count) = expected_page_nonws {
                    let all = text.chars();
                    let count = (0..all.len())
                        .filter_map(|i| all.get(i).ok())
                        .filter_map(|c| c.unicode_char())
                        .filter(|u| !u.is_whitespace())
                        .count();
                    if count != expected_count {
                        return Err("insert_collision".to_string());
                    }
                }
                let bounds = object.bounds().map_err(|e| e.to_string())?;
                let current_left = bounds.left().value as f64;
                let current_bottom = bounds.bottom().value as f64;
                if (current_bottom - cont.bottom).abs() > POSITION_TOLERANCE_PT {
                    return Err("fragment_baseline_divergence".to_string());
                }
                let deleted_width = located.object_right - located.object_left;
                let error = cont.left - deleted_width - current_left;
                return Ok(FidelityOutcome {
                    column_shift: None,
                    fragment_shift: (error.abs() > POSITION_TOLERANCE_PT).then_some(error),
                    object_right: located.object_left,
                    inserted_rects: Vec::new(),
                    text_is_dark,
                });
            }
        }
        let chars = text.chars_for_object(text_obj).map_err(|e| e.to_string())?;
        for c in chars.iter() {
            own_indices.insert(c.index());
            let Some(u) = c.unicode_char() else { continue };
            if u.is_whitespace() {
                continue;
            }
            match c.loose_bounds() {
                Ok(rect) => {
                    object_right = object_right.max(rect.right().value as f64);
                    new_positions.push((
                        rect.left().value as f64,
                        rect.bottom().value as f64,
                        u,
                    ));
                    new_rects.push(Some((
                        rect.left().value as f64,
                        rect.bottom().value as f64,
                        rect.right().value as f64,
                        rect.top().value as f64,
                    )));
                }
                Err(_) => {
                    new_positions.push((f64::NAN, f64::NAN, u));
                    new_rects.push(None);
                }
            }
        }
        acc.push_str(&strip_whitespace(&text.for_object(text_obj)));
        if acc == plan.expected {
            found = true;
            break;
        }
        if !plan.expected.starts_with(acc.as_str()) {
            return Err("missing_glyphs".to_string());
        }
    }
    if !found {
        return Err(if ordinal <= located.text_ordinal {
            "text_object_not_found".to_string()
        } else {
            "missing_glyphs".to_string()
        });
    }
    let old_kept: Vec<&(f64, f64, char, KeptClass)> = plan
        .kept
        .iter()
        .filter(|(_, _, u, _)| !u.is_whitespace())
        .collect();
    if new_positions.len() != old_kept.len() + plan.inserted_nonws_count {
        return Err("missing_glyphs".to_string());
    }
    let prefix_count = old_kept
        .iter()
        .filter(|(_, _, _, class)| *class == KeptClass::Prefix)
        .count();
    // Glyphe inséré sans boîte (ou de taille nulle) : le code est couvert par
    // le ToUnicode (l'extraction « voit » le caractère) mais la police
    // SOUS-ENSEMBLE n'embarque pas son contour — rien ne se dessine. C'est un
    // glyphe manquant, pas un recouvrement : l'appelant affiche le badge
    // police et bascule en HTML.
    if new_rects[prefix_count..prefix_count + plan.inserted_nonws_count]
        .iter()
        .any(|r| match r {
            None => true,
            Some((l, b, r2, t)) => (r2 - l) < 0.05 || (t - b) < 0.05,
        })
    {
        return Err("missing_glyphs".to_string());
    }
    let inserted_rects: Vec<(f64, f64, f64, f64)> = new_rects
        [prefix_count..prefix_count + plan.inserted_nonws_count]
        .iter()
        .flatten()
        .copied()
        .collect();

    // Suite de ligne dans un autre show-op : sa position attendue est sa
    // position originale + la CROISSANCE du show-op édité. La première passe
    // mesure cette croissance ; la seconde ajuste le `Td` relatif et doit
    // ramener l'erreur sous la tolérance.
    let fragment_shift = if !located.continuations.is_empty() {
        let mut current_bounds: Vec<Option<(f64, f64)>> = Vec::new();
        for object in page.objects().iter() {
            if object.as_text_object().is_none() {
                continue;
            }
            current_bounds.push(object.bounds().ok().map(|bounds| {
                (
                    bounds.left().value as f64,
                    bounds.bottom().value as f64,
                )
            }));
        }
        let growth = object_right - located.object_right;
        let mut required_shift: Option<f64> = None;
        for continuation in &located.continuations {
            let Some(Some((current_left, current_bottom))) =
                current_bounds.get(continuation.text_ordinal)
            else {
                return Err("fragment_missing".to_string());
            };
            if (*current_bottom - continuation.bottom).abs() > POSITION_TOLERANCE_PT {
                return Err("fragment_baseline_divergence".to_string());
            }
            let error = continuation.left + growth - *current_left;
            if let Some(reference) = required_shift {
                if (error - reference).abs() > POSITION_TOLERANCE_PT {
                    return Err("fragment_layout_divergence".to_string());
                }
            } else {
                required_shift = Some(error);
            }
        }
        required_shift.filter(|error| error.abs() > POSITION_TOLERANCE_PT)
    } else {
        None
    };

    // Collision : deux contrôles complémentaires, appliqués au moment de
    // l'ACCEPTATION seulement (les décalages de colonnes sont compensés par
    // une passe ultérieure).
    // 1. Compte global de glyphes : un glyphe décalé qui se superpose à un
    //    glyphe IDENTIQUE d'un autre objet fusionne dans la page texte PDFium
    //    (un « 1 » sur le « 1 » du run voisin n'en laisse qu'un) — perte
    //    invisible au rectangle.
    // 2. Rectangles des glyphes INSÉRÉS : insertion en fin d'objet alors que
    //    la suite de la ligne est positionnée par des Td explicites — elle ne
    //    se décale pas et le caractère s'imprime PAR-DESSUS.
    // Le chevauchement du SUFFIXE décalé avec un voisin (frappe répétée
    // jusqu'à toucher la colonne d'à côté) reste accepté : comportement voulu,
    // couvert par `native_edit_survives_block_merge_from_widened_text`.
    let collides_with_other_objects = |moved_rects: &[(f64, f64, f64, f64)]| -> bool {
        // Comptage global : deux glyphes IDENTIQUES amenés à se superposer
        // fusionnent dans la page texte PDFium (un « 1 » décalé sur le « 1 »
        // d'un objet voisin n'en laisse qu'un à l'extraction). Le rectangle
        // seul ne le voit pas — le compte de caractères non blancs, si.
        if let Some(expected_count) = expected_page_nonws {
            let all = text.chars();
            let mut count = 0usize;
            for i in 0..all.len() {
                if let Ok(c) = all.get(i) {
                    if let Some(u) = c.unicode_char() {
                        if !u.is_whitespace() {
                            count += 1;
                        }
                    }
                }
            }
            if count != expected_count {
                if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                    eprintln!(
                        "[stream-debug] COLLISION compte page {count} != attendu {expected_count}"
                    );
                }
                return true;
            }
        }
        if moved_rects.is_empty() {
            return false;
        }
        let all_chars = text.chars();
        for i in 0..all_chars.len() {
            if own_indices.contains(&i) {
                continue;
            }
            let Ok(c) = all_chars.get(i) else { continue };
            let Some(u) = c.unicode_char() else { continue };
            if u.is_whitespace() {
                continue;
            }
            let Ok(rect) = c.loose_bounds() else { continue };
            let (cl, cb, cr, ct) = (
                rect.left().value as f64,
                rect.bottom().value as f64,
                rect.right().value as f64,
                rect.top().value as f64,
            );
            for &(il, ib, ir, it) in moved_rects {
                let ox = (ir.min(cr) - il.max(cl)).max(0.0);
                let oy = (it.min(ct) - ib.max(cb)).max(0.0);
                let min_w = (ir - il).min(cr - cl).max(0.01);
                let min_h = (it - ib).min(ct - cb).max(0.01);
                // Recouvrement significatif (pas un simple frôlement de
                // crénage) : plus du tiers de la largeur ET de la hauteur.
                if ox > min_w * 0.34 && oy > min_h * 0.34 {
                    if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                        eprintln!(
                            "[stream-debug] COLLISION moved=({il:.1},{ib:.1},{ir:.1},{it:.1}) char {u:?}@{i}=({cl:.1},{cb:.1},{cr:.1},{ct:.1})"
                        );
                    }
                    return true;
                }
            }
        }
        false
    };

    // Préfixe : immobile, au caractère près.
    for i in 0..prefix_count {
        let &(old_left, old_bottom, _, _) = old_kept[i];
        if old_left.is_nan() {
            continue;
        }
        let (new_left, new_bottom, _) = new_positions[i];
        if new_left.is_nan()
            || (new_left - old_left).abs() > POSITION_TOLERANCE_PT
            || (new_bottom - old_bottom).abs() > POSITION_TOLERANCE_PT
        {
            if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                eprintln!(
                    "[stream-debug] divergence PRÉFIXE i={i} char={:?} old=({old_left:.2},{old_bottom:.2}) new=({new_left:.2},{new_bottom:.2})",
                    old_kept[i].2
                );
            }
            return Err("layout_divergence".to_string());
        }
    }

    // Suffixe de la colonne éditée : décalage horizontal UNIFORME, baseline
    // inchangée. Colonnes suivantes : décalage mesuré (0 attendu après
    // compensation — sinon la valeur pilote la passe de compensation).
    let mut same_col_delta: Option<f64> = None;
    let mut column_shifts: Vec<f64> = Vec::new();
    for j in prefix_count..old_kept.len() {
        let &(old_left, old_bottom, _, class) = old_kept[j];
        if old_left.is_nan() {
            continue;
        }
        let (new_left, new_bottom, _) = new_positions[j + plan.inserted_nonws_count];
        if new_left.is_nan() || (new_bottom - old_bottom).abs() > POSITION_TOLERANCE_PT {
            if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                eprintln!(
                    "[stream-debug] divergence BASELINE j={j} char={:?} old=({old_left:.2},{old_bottom:.2}) new=({new_left:.2},{new_bottom:.2})",
                    old_kept[j].2
                );
            }
            return Err("layout_divergence".to_string());
        }
        let delta = new_left - old_left;
        match class {
            KeptClass::Prefix => unreachable!(),
            KeptClass::SameColumn => match same_col_delta {
                None => same_col_delta = Some(delta),
                Some(reference) => {
                    if (delta - reference).abs() > POSITION_TOLERANCE_PT {
                        if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                            eprintln!(
                                "[stream-debug] divergence SUFFIXE j={j} char={:?} delta={delta:.2} ref={reference:.2}",
                                old_kept[j].2
                            );
                        }
                        return Err("layout_divergence".to_string());
                    }
                }
            },
            KeptClass::LaterColumns => column_shifts.push(delta),
        }
    }
    if column_shifts.is_empty() {
        if fragment_shift.is_none() && collides_with_other_objects(&inserted_rects) {
            return Err("insert_collision".to_string());
        }
        return Ok(FidelityOutcome {
            column_shift: None,
            fragment_shift,
            object_right,
            inserted_rects,
            text_is_dark,
        });
    }
    // Les colonnes suivantes doivent bouger d'un bloc (delta uniforme entre
    // elles) — sinon le splice a corrompu la structure interne.
    let first = column_shifts[0];
    for &shift in &column_shifts[1..] {
        if (shift - first).abs() > POSITION_TOLERANCE_PT {
            if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                eprintln!(
                    "[stream-debug] divergence COLONNES shift={shift:.2} first={first:.2} shifts={column_shifts:?}"
                );
            }
            return Err("layout_divergence".to_string());
        }
    }
    if first.abs() <= COLUMN_TOLERANCE_PT {
        if fragment_shift.is_none() && collides_with_other_objects(&inserted_rects) {
            return Err("insert_collision".to_string());
        }
        return Ok(FidelityOutcome {
            column_shift: None,
            fragment_shift,
            object_right,
            inserted_rects,
            text_is_dark,
        });
    }
    Ok(FidelityOutcome {
        column_shift: Some(first),
        fragment_shift,
        object_right,
        inserted_rects,
        text_is_dark,
    })
}

// ─── Rendu de bande + rapport (identique au chemin set_text) ─────────────────

#[allow(clippy::too_many_arguments)]
fn render_report(
    out_bytes: Vec<u8>,
    page_number: u32,
    page_index: i32,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
    visibility_check: Option<&[(f64, f64, f64, f64)]>,
) -> Result<NativeTextEditOutcome, String> {
    let parts = {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let doc = pdfium
            .load_pdf_from_byte_slice(&out_bytes, None)
            .map_err(|e| e.to_string())?;
        let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;
        let page_width = page.width().value as f64;
        let page_height = page.height().value as f64;
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
        let image_width_px = rendered.width();
        let image_height_px = rendered.height();
        let px_per_pt = image_height_px as f64 / page_height.max(1.0);

        // Contrôle de visibilité : chaque glyphe inséré (sombre) doit produire
        // au moins quelques pixels sombres — sinon il est recouvert par un
        // fond peint après lui (texte « blanc/invisible ») et l'édition est
        // refusée plutôt que de committer un document illisible.
        if let Some(rects) = visibility_check {
            if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                let _ = std::fs::write("/tmp/stream_debug_out.pdf", &out_bytes);
            }
            let rgba = rendered.to_rgba8();
            let px_per_pt_x = image_width_px as f64 / page_width.max(1.0);
            let mut visible = 0usize;
            for &(left, bottom, right, top) in rects {
                let x0 = ((left * px_per_pt_x).floor().max(0.0) as u32).min(image_width_px);
                let x1 = ((right * px_per_pt_x).ceil().max(0.0) as u32).min(image_width_px);
                let y0 = (((page_height - top) * px_per_pt).floor().max(0.0) as u32)
                    .min(image_height_px);
                let y1 = (((page_height - bottom) * px_per_pt).ceil().max(0.0) as u32)
                    .min(image_height_px);
                let mut dark = 0usize;
                'scan: for y in y0..y1 {
                    for x in x0..x1 {
                        let p = rgba.get_pixel(x, y);
                        let lum = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
                        if lum < 176.0 {
                            dark += 1;
                            if dark >= 2 {
                                break 'scan;
                            }
                        }
                    }
                }
                if dark >= 2 {
                    visible += 1;
                }
                if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
                    eprintln!(
                        "[stream-debug] vis rect=({left:.2},{bottom:.2},{right:.2},{top:.2}) px=({x0},{y0})..({x1},{y1}) dark={dark}"
                    );
                }
            }
            // Tolérance : un glyphe fin peut rater le seuil (anti-aliasing) ;
            // mais si moins de la moitié des glyphes insérés sont visibles,
            // c'est un recouvrement.
            if !rects.is_empty() && visible * 2 < rects.len() {
                return Err("covered_insert".to_string());
            }
        }
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
        )
    };
    let analysis = analyze_pdf_page(&out_bytes, page_number)?;
    let (strip_png_base64, strip_top_px, strip_height_px, image_width_px, image_height_px) = parts;
    Ok(NativeTextEditOutcome {
        bytes: out_bytes,
        report: NativeTextEditReport {
            strip_png_base64,
            strip_top_px,
            strip_height_px,
            image_width_px,
            image_height_px,
            glyphs_ok: true,
            analysis,
        },
    })
}

// ─── Point d'entrée ──────────────────────────────────────────────────────────

/// Édition de texte par splice du flux de contenu. Mêmes arguments et même
/// contrat que `edit_pdf_text_native` : en cas d'erreur, le document original
/// est intact et l'appelant peut tenter un autre chemin.
#[allow(clippy::too_many_arguments)]
pub fn edit_pdf_text_stream(
    bytes: &[u8],
    page_number: u32,
    removed_char_indices: &[u32],
    insert_after_char_index: i64,
    insert_before_char_index: i64,
    inserted: &str,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
    replace_whitespace_run: bool,
) -> Result<NativeTextEditOutcome, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }
    if removed_char_indices.is_empty() && inserted.is_empty() && !replace_whitespace_run {
        return Err("empty_edit".to_string());
    }
    if inserted.contains('\n') || inserted.contains('\r') {
        return Err("multiline_insert".to_string());
    }
    if !(scale > 0.0) || !(strip_height > 0.0) {
        return Err("invalid_strip".to_string());
    }
    let removed: BTreeSet<i64> = removed_char_indices.iter().map(|&i| i as i64).collect();
    let mut anchor_indices: Vec<i64> = removed.iter().copied().collect();
    // Suppression pure : les ancres voisines ne servent pas au plan (aucun
    // octet à insérer). Sur les PDF « un Tj par glyphe », elles appartiennent
    // à d'autres objets et provoqueraient un faux `multi_object_edit`, suivi
    // d'un repli HTML avec changement de police. On ne les utilise que pour
    // une insertion réelle.
    if !inserted.is_empty() || replace_whitespace_run {
        if insert_after_char_index >= 0 {
            anchor_indices.push(insert_after_char_index);
        }
        if insert_before_char_index >= 0 {
            anchor_indices.push(insert_before_char_index);
        }
    }
    if anchor_indices.is_empty() {
        return Err("no_anchor".to_string());
    }
    let page_index = page_number
        .checked_sub(1)
        .ok_or_else(|| "Page numbers start at 1.".to_string())? as i32;

    // Phase 1 : localisation + plan (PDFium, lecture seule).
    let (located, plan, expected_page_nonws) = {
        let guard = pdfium_guard()?;
        let pdfium = &*guard;
        let document = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| e.to_string())?;
        let page = document.pages().get(page_index).map_err(|e| e.to_string())?;
        // Ancres « molles » : index page dont le caractère est un espace —
        // potentiellement GÉNÉRÉ par l'extraction de texte (aucun octet dans le
        // flux, absent des objets). Elles ne servent pas à localiser l'objet et
        // sont résolues vers leurs voisins réels dans build_plan.
        let soft_anchors: BTreeSet<i64> = {
            let text = page.text().map_err(|e| e.to_string())?;
            let all_chars = text.chars();
            anchor_indices
                .iter()
                .copied()
                .filter(|&idx| {
                    idx >= 0
                        && all_chars
                            .get(idx as usize)
                            .ok()
                            .and_then(|c| c.unicode_char())
                            .map(|u| u.is_whitespace())
                            .unwrap_or(false)
                })
                .collect()
        };
        let mut hard_anchors: Vec<i64> = anchor_indices
            .iter()
            .copied()
            .filter(|idx| !soft_anchors.contains(idx))
            .collect();
        if hard_anchors.is_empty() {
            // Toutes les ancres sont molles (ex : frappe juste après l'espace
            // généré d'un écart de colonne) : localiser via le voisin RÉEL du
            // côté où l'insertion doit tomber.
            let text = page.text().map_err(|e| e.to_string())?;
            let all_chars = text.chars();
            let total = all_chars.len() as i64;
            let non_ws_at = |idx: i64| -> bool {
                idx >= 0
                    && all_chars
                        .get(idx as usize)
                        .ok()
                        .and_then(|c| c.unicode_char())
                        .map(|u| !u.is_whitespace())
                        .unwrap_or(false)
            };
            if insert_after_char_index >= 0 {
                let mut idx = insert_after_char_index + 1;
                while idx < total && !non_ws_at(idx) {
                    idx += 1;
                }
                if idx < total {
                    hard_anchors.push(idx);
                }
            } else if insert_before_char_index >= 0 {
                let mut idx = insert_before_char_index - 1;
                while idx >= 0 && !non_ws_at(idx) {
                    idx -= 1;
                }
                if idx >= 0 {
                    hard_anchors.push(idx);
                }
            }
            if hard_anchors.is_empty() {
                return Err("no_hard_anchor".to_string());
            }
        }
        let located = locate_object(&page, &hard_anchors)?;
        let plan = build_plan(
            &located,
            &removed,
            insert_after_char_index,
            insert_before_char_index,
            inserted,
            &soft_anchors,
            replace_whitespace_run,
        )?;
        // Compte de caractères non blancs attendu sur la page APRÈS édition :
        // sert au contrôle de collision (deux glyphes identiques superposés
        // fusionnent dans la page texte — le compte chute).
        let expected_page_nonws = {
            let text = page.text().map_err(|e| e.to_string())?;
            let all = text.chars();
            let mut count = 0usize;
            let mut removed_nonws = 0usize;
            for i in 0..all.len() {
                if let Ok(c) = all.get(i) {
                    if let Some(u) = c.unicode_char() {
                        if !u.is_whitespace() {
                            count += 1;
                            if removed.contains(&(i as i64)) {
                                removed_nonws += 1;
                            }
                        }
                    }
                }
            }
            count - removed_nonws + plan.inserted_nonws_count
        };
        (located, plan, expected_page_nonws)
    };

    // Phase 2 : splice + vérification. Si la police d'origine ne peut pas
    // écrire le texte inséré (encodage restreint ou glyphe absent du
    // sous-ensemble embarqué), on rejoue la phase avec une POLICE DE SECOURS
    // embarquée (comportement Adobe : les caractères ajoutés prennent une
    // police proche, le texte d'origine reste intact).
    let first = run_edit_passes(
        bytes,
        page_number,
        page_index,
        &located,
        &plan,
        inserted,
        replace_whitespace_run,
        strip_top,
        strip_height,
        scale,
        None,
        expected_page_nonws,
    );
    if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
        if let Err(err) = &first {
            eprintln!(
                "[stream-debug] passe 1 (police d'origine) échouée : {err} (objet {}, police {})",
                located.text_ordinal, located.font_name
            );
        }
    }
    match first {
        Ok(outcome) => Ok(outcome),
        Err(err) if err == "unencodable_insert" || err == "missing_glyphs" => {
            if inserted.is_empty() {
                return Err(err);
            }
            let style = crate::pdf_fallback_font::style_for_font_name(&located.font_name);
            if !crate::pdf_fallback_font::can_render(style, inserted) {
                return Err(err);
            }
            run_edit_passes(
                bytes,
                page_number,
                page_index,
                &located,
                &plan,
                inserted,
                replace_whitespace_run,
                strip_top,
                strip_height,
                scale,
                Some(style),
                expected_page_nonws,
            )
        }
        Err(err) => Err(err),
    }
}

/// Boucle splice + vérification : compensation de colonne empirique (2 passes
/// max : mesure du décalage, puis correction par pente mesurée),
/// élargissement de clip si le texte inséré déborde de sa cellule, et
/// perçage des fonds blancs peints APRÈS le texte qui le recouvriraient
/// (fonds des cellules voisines : caractères « invisibles/blancs »).
#[allow(clippy::too_many_arguments)]
fn run_edit_passes(
    bytes: &[u8],
    page_number: u32,
    page_index: i32,
    located: &LocatedObject,
    plan: &EditPlan,
    inserted: &str,
    replace_whitespace_run: bool,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
    fallback: Option<crate::pdf_fallback_font::FallbackStyle>,
    expected_page_nonws: usize,
) -> Result<NativeTextEditOutcome, String> {
    let mut comp_units = 0.0f64;
    let mut fragment_shift_pt = 0.0f64;
    let mut previous: Option<(f64, f64)> = None; // (comp_units, décalage mesuré)
    let mut widen_clip_to: Option<f64> = None;
    let mut punch_to: Option<f64> = None;
    for _pass in 0..6 {
        let (out_bytes, clip) = splice_content(
            bytes,
            page_number,
            located,
            plan,
            inserted,
            replace_whitespace_run,
            comp_units,
            fragment_shift_pt,
            widen_clip_to,
            punch_to,
            fallback,
        )?;
        let outcome = {
            let guard = pdfium_guard()?;
            let pdfium = &*guard;
            let doc = pdfium
                .load_pdf_from_byte_slice(&out_bytes, None)
                .map_err(|e| e.to_string())?;
            let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;
            verify_fidelity(&page, located, plan, Some(expected_page_nonws))?
        };
        // Troncature par clip : le bord droit de l'objet dépasse le clip actif
        // le plus contraignant → réécrire avec le clip élargi. Un clip complexe
        // (chemin non rectangulaire) n'est jamais modifié : édition refusée
        // plutôt que des caractères invisibles.
        if let Some(min_right) = clip.min_right {
            let needed = outcome.object_right + 1.0;
            if outcome.object_right > min_right - 0.25 {
                if clip.complex {
                    return Err("clipped_insert".to_string());
                }
                if widen_clip_to.map_or(true, |w| w < needed) {
                    widen_clip_to = Some(needed);
                    continue;
                }
            }
        }
        // Recouvrement par un fond peint après le texte : re-splicer en
        // perçant les fonds blancs jusqu'au bord droit réel de l'objet. Un
        // recouvrement non perçable (fond coloré, chemin complexe) est refusé.
        if std::env::var("ALTO_STREAM_DEBUG").is_ok() {
            eprintln!(
                "[stream-debug] pass object_right={:.2} min_right={:?} cover_left={:?} cover_blocked_left={:?} column_shift={:?} fragment_shift={:?}",
                outcome.object_right,
                clip.min_right,
                clip.cover_left,
                clip.cover_blocked_left,
                outcome.column_shift,
                outcome.fragment_shift
            );
        }
        if let Some(blocked_left) = clip.cover_blocked_left {
            if outcome.object_right > blocked_left + 0.25 {
                return Err("covered_insert".to_string());
            }
        }
        if let Some(cover_left) = clip.cover_left {
            let needed = outcome.object_right + 1.0;
            if outcome.object_right > cover_left + 0.25
                && punch_to.map_or(true, |p| p < needed)
            {
                punch_to = Some(needed);
                continue;
            }
        }
        if let Some(shift) = outcome.fragment_shift {
            if clip.fragment_shift_supported {
                fragment_shift_pt += shift;
                continue;
            }
            // Une continuation proche mais dans un AUTRE BT/ET ne partage pas
            // la matrice de ligne : on conserve le comportement historique
            // tant qu'elle reste physiquement séparée. Au contact seulement,
            // refus propre (pas de reconstruction large implicite).
            let overlaps_unsupported = located
                .continuation
                .map(|cont| outcome.object_right > cont.left + 0.75)
                .unwrap_or(false);
            if overlaps_unsupported {
                return Err("insert_collision".to_string());
            }
        }
        let Some(shift) = outcome.column_shift else {
            // Fidélité totale (colonnes immobiles ou absentes) : rendu final,
            // avec contrôle pixel de visibilité des glyphes insérés sombres.
            let check = (outcome.text_is_dark && !outcome.inserted_rects.is_empty())
                .then_some(outcome.inserted_rects.as_slice());
            return render_report(
                out_bytes,
                page_number,
                page_index,
                strip_top,
                strip_height,
                scale,
                check,
            );
        };
        // Décalage de colonnes résiduel : ajuster la compensation TJ.
        // Un nombre TJ `k` décale le texte suivant de −k/1000 × taille police.
        let next = match previous {
            None => comp_units + shift * 1000.0 / located.scaled_font_size,
            Some((prev_units, prev_shift)) => {
                let slope = (shift - prev_shift) / (comp_units - prev_units);
                if !slope.is_finite() || slope.abs() < 1e-9 {
                    return Err("layout_divergence".to_string());
                }
                comp_units - shift / slope
            }
        };
        previous = Some((comp_units, shift));
        comp_units = next;
    }
    Err("layout_divergence".to_string())
}
