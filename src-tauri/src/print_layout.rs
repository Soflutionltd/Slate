//! Imposition PDF pour l’impression — mise à l’échelle et centrage explicites.
//!
//! Pourquoi ce module : macOS ne fournit pas le filtre `pdftopdf` de
//! cups-filters. Sa chaîne d’impression (`cgpdftoraster`) ignore
//! silencieusement `print-scaling`, `fit-to-page` et `scaling=N` — `lp` accepte
//! l’option, ne renvoie aucune erreur, et le driver ancre puis rogne comme il
//! veut. C’est la cause des étiquettes 4×6 décalées et coupées.
//!
//! La seule façon fiable d’imposer une échelle est donc de la faire nous-mêmes :
//! on réécrit le PDF pour que chaque page fasse EXACTEMENT la taille du papier,
//! contenu mis à l’échelle et centré. Le driver n’a plus rien à décider, et
//! l’aperçu du panneau correspond au papier qui sort.
//!
//! Le `/Rotate` de la page et l’orientation demandée sont absorbés dans la
//! matrice : le MediaBox produit garde toujours l’orientation du media CUPS
//! choisi, jamais l’inverse. Un driver qui se fie à `media=` plutôt qu’au
//! MediaBox ne peut donc pas nous tourner la page une seconde fois.

use std::collections::BTreeMap;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use alto_pdf_engine::pdf_label::{analyze_label_page, ContentBand, LabelLayout};

/// Mode d’échelle, aligné sur le panneau d’impression.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScaleMode {
    /// 100 %, centré sur la feuille.
    Actual,
    /// Réduit ou agrandit pour tenir entièrement dans la feuille.
    Fit,
    /// Couvre la feuille, en débordant si les ratios diffèrent.
    Fill,
    /// Comme `Fit`, mais jamais d’agrandissement.
    Shrink,
    /// Pourcentage explicite.
    Custom(f64),
}

/// Orientation demandée pour la feuille.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Orientation {
    /// Tourne la page de 90° si son sens diffère de celui de la feuille.
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy)]
pub struct Imposition {
    /// Largeur du media CUPS, en points PostScript (telle que donnée par le PPD).
    pub sheet_width_pts: f64,
    /// Hauteur du media CUPS, en points PostScript.
    pub sheet_height_pts: f64,
    pub mode: ScaleMode,
    pub orientation: Orientation,
}

/// Matrice PDF `a b c d e f` : x' = a·x + c·y + e, y' = b·x + d·y + f.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Matrix {
    /// Applique la matrice à un point.
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    fn to_cm(self) -> String {
        // 5 décimales : bien en deçà de la précision d’un rasteriseur, et évite
        // les notations exponentielles que certains parseurs digèrent mal.
        format!(
            "{:.5} {:.5} {:.5} {:.5} {:.5} {:.5} cm",
            self.a, self.b, self.c, self.d, self.e, self.f
        )
    }
}

/// Rectangle `[x0 y0 x1 y1]` normalisé (x0 < x1, y0 < y1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub fn new(a: f64, b: f64, c: f64, d: f64) -> Self {
        Self {
            x0: a.min(c),
            y0: b.min(d),
            x1: a.max(c),
            y1: b.max(d),
        }
    }

    pub fn width(&self) -> f64 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f64 {
        self.y1 - self.y0
    }
}

/// Résultat du placement d’une page sur une feuille.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub matrix: Matrix,
    /// Échelle uniforme appliquée (1.0 = taille réelle).
    #[allow(dead_code)]
    pub scale: f64,
    /// Rotation totale absorbée dans la matrice, en degrés horaires.
    #[allow(dead_code)]
    pub rotation: i64,
}

/// Ramène un `/Rotate` quelconque dans {0, 90, 180, 270}.
fn normalize_rotation(rotate: i64) -> i64 {
    let r = rotate % 360;
    let r = if r < 0 { r + 360 } else { r };
    // Les valeurs non multiples de 90 sont invalides selon la spec : on ignore.
    match r {
        90 => 90,
        180 => 180,
        270 => 270,
        _ => 0,
    }
}

/// Calcule la matrice qui place `page` (avec son `/Rotate`) sur une feuille.
///
/// La rotation de la page et celle induite par l’orientation demandée sont
/// fusionnées : l’appelant peut donc remettre `/Rotate 0` et poser
/// `MediaBox [0 0 sheet_w sheet_h]`.
pub fn place_page(
    page: Rect,
    page_rotate: i64,
    sheet_width: f64,
    sheet_height: f64,
    mode: ScaleMode,
    orientation: Orientation,
) -> Placement {
    let base_rotation = normalize_rotation(page_rotate);
    // Dimensions telles que le lecteur les affiche, /Rotate appliqué.
    let (visible_w, visible_h) = if base_rotation == 90 || base_rotation == 270 {
        (page.height(), page.width())
    } else {
        (page.width(), page.height())
    };

    let page_is_landscape = visible_w > visible_h;
    let sheet_is_landscape = sheet_width > sheet_height;
    let quarter_turn = match orientation {
        Orientation::Auto => page_is_landscape != sheet_is_landscape,
        Orientation::Portrait => false,
        Orientation::Landscape => !sheet_is_landscape,
    };

    let rotation = if quarter_turn {
        (base_rotation + 90) % 360
    } else {
        base_rotation
    };
    // Après le quart de tour éventuel, les dimensions utiles sont inversées.
    let (final_w, final_h) = if quarter_turn {
        (visible_h, visible_w)
    } else {
        (visible_w, visible_h)
    };

    let scale = resolve_scale(final_w, final_h, sheet_width, sheet_height, mode);
    let center_x = (sheet_width - final_w * scale) / 2.0;
    let center_y = (sheet_height - final_h * scale) / 2.0;

    // Composition : translation vers l’origine du MediaBox, rotation horaire,
    // échelle, puis centrage. Les quatre cas sont développés à la main — c’est
    // plus lisible qu’un produit de matrices générique pour quatre angles.
    let (w, h) = (page.width(), page.height());
    let s = scale;
    let matrix = match rotation {
        90 => Matrix {
            a: 0.0,
            b: -s,
            c: s,
            d: 0.0,
            e: center_x - s * page.y0,
            f: center_y + s * (w + page.x0),
        },
        180 => Matrix {
            a: -s,
            b: 0.0,
            c: 0.0,
            d: -s,
            e: center_x + s * (w + page.x0),
            f: center_y + s * (h + page.y0),
        },
        270 => Matrix {
            a: 0.0,
            b: s,
            c: -s,
            d: 0.0,
            e: center_x + s * (h + page.y0),
            f: center_y - s * page.x0,
        },
        _ => Matrix {
            a: s,
            b: 0.0,
            c: 0.0,
            d: s,
            e: center_x - s * page.x0,
            f: center_y - s * page.y0,
        },
    };

    Placement {
        matrix,
        scale,
        rotation,
    }
}

fn resolve_scale(
    page_w: f64,
    page_h: f64,
    sheet_w: f64,
    sheet_h: f64,
    mode: ScaleMode,
) -> f64 {
    if page_w <= 0.0 || page_h <= 0.0 || sheet_w <= 0.0 || sheet_h <= 0.0 {
        return 1.0;
    }
    let fit = (sheet_w / page_w).min(sheet_h / page_h);
    let fill = (sheet_w / page_w).max(sheet_h / page_h);
    let scale = match mode {
        ScaleMode::Actual => 1.0,
        ScaleMode::Fit => fit,
        ScaleMode::Fill => fill,
        ScaleMode::Shrink => fit.min(1.0),
        ScaleMode::Custom(pct) => pct / 100.0,
    };
    // Garde-fou : une échelle nulle ou absurde produirait une page blanche.
    scale.clamp(0.01, 100.0)
}

/// Remonte la chaîne `/Parent` pour lire un attribut de page héritable.
fn inherited_attribute(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    // La spec autorise l’héritage sur toute la chaîne ; on borne pour ne pas
    // boucler sur un arbre de pages corrompu.
    for _ in 0..32 {
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(value) = dict.get(key) {
            if let Ok((_, resolved)) = doc.dereference(value) {
                return Some(resolved.clone());
            }
        }
        let parent = dict.get(b"Parent").ok()?;
        current = parent.as_reference().ok()?;
    }
    None
}

fn object_to_f64(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn rect_from_object(doc: &Document, object: &Object) -> Option<Rect> {
    let array = object.as_array().ok()?;
    if array.len() < 4 {
        return None;
    }
    let mut values = [0.0_f64; 4];
    for (slot, item) in values.iter_mut().zip(array.iter()) {
        let resolved = doc.dereference(item).ok()?.1;
        *slot = object_to_f64(resolved)?;
    }
    let rect = Rect::new(values[0], values[1], values[2], values[3]);
    if rect.width() <= 0.0 || rect.height() <= 0.0 {
        return None;
    }
    Some(rect)
}

/// MediaBox effectif de la page (héritage compris), avec repli Letter.
fn page_media_box(doc: &Document, page_id: ObjectId) -> Rect {
    inherited_attribute(doc, page_id, b"MediaBox")
        .and_then(|object| rect_from_object(doc, &object))
        .unwrap_or(Rect {
            x0: 0.0,
            y0: 0.0,
            x1: 612.0,
            y1: 792.0,
        })
}

fn page_rotation(doc: &Document, page_id: ObjectId) -> i64 {
    inherited_attribute(doc, page_id, b"Rotate")
        .and_then(|object| object.as_i64().ok())
        .unwrap_or(0)
}

/// Transforme les rectangles d’annotations pour qu’ils suivent le contenu.
fn transform_annotations(doc: &mut Document, page_id: ObjectId, matrix: Matrix) {
    let Ok(page_dict) = doc.get_dictionary(page_id) else {
        return;
    };
    let Ok(annots) = page_dict.get(b"Annots") else {
        return;
    };
    let ids: Vec<ObjectId> = match doc.dereference(annots).map(|(_, object)| object) {
        Ok(Object::Array(items)) => items.iter().filter_map(|i| i.as_reference().ok()).collect(),
        _ => Vec::new(),
    };

    for annot_id in ids {
        let rect = doc
            .get_dictionary(annot_id)
            .ok()
            .and_then(|dict| dict.get(b"Rect").ok().cloned())
            .and_then(|object| rect_from_object(doc, &object));
        let quads: Option<Vec<f64>> = doc
            .get_dictionary(annot_id)
            .ok()
            .and_then(|dict| dict.get(b"QuadPoints").ok().cloned())
            .and_then(|object| object.as_array().ok().cloned())
            .map(|items| items.iter().filter_map(object_to_f64).collect());

        if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(annot_id) {
            if let Some(rect) = rect {
                // Avec une rotation, les coins tournent : on reprend la bbox
                // englobante des quatre coins transformés.
                let corners = [
                    matrix.apply(rect.x0, rect.y0),
                    matrix.apply(rect.x1, rect.y0),
                    matrix.apply(rect.x1, rect.y1),
                    matrix.apply(rect.x0, rect.y1),
                ];
                let xs = corners.map(|(x, _)| x);
                let ys = corners.map(|(_, y)| y);
                let x0 = xs.iter().cloned().fold(f64::INFINITY, f64::min);
                let x1 = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let y0 = ys.iter().cloned().fold(f64::INFINITY, f64::min);
                let y1 = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                dict.set(
                    "Rect",
                    Object::Array(vec![
                        Object::Real(x0 as f32),
                        Object::Real(y0 as f32),
                        Object::Real(x1 as f32),
                        Object::Real(y1 as f32),
                    ]),
                );
            }
            if let Some(quads) = quads {
                if quads.len() >= 8 && quads.len() % 2 == 0 {
                    let mut mapped = Vec::with_capacity(quads.len());
                    for pair in quads.chunks_exact(2) {
                        let (x, y) = matrix.apply(pair[0], pair[1]);
                        mapped.push(Object::Real(x as f32));
                        mapped.push(Object::Real(y as f32));
                    }
                    dict.set("QuadPoints", Object::Array(mapped));
                }
            }
        }
    }
}

/// Réécrit le PDF pour que chaque page fasse exactement la taille de la feuille.
///
/// Renvoie les octets du PDF imposé. Le PDF d’entrée n’est pas modifié.
pub fn impose(bytes: &[u8], settings: &Imposition) -> Result<Vec<u8>, String> {
    if settings.sheet_width_pts <= 1.0 || settings.sheet_height_pts <= 1.0 {
        return Err("Dimensions de papier invalides pour l’imposition.".into());
    }
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err("Le PDF ne contient aucune page.".into());
    }

    let sheet_w = settings.sheet_width_pts;
    let sheet_h = settings.sheet_height_pts;

    for page_id in pages.values().copied() {
        let media = page_media_box(&doc, page_id);
        let rotate = page_rotation(&doc, page_id);
        let placement = place_page(
            media,
            rotate,
            sheet_w,
            sheet_h,
            settings.mode,
            settings.orientation,
        );

        let original = doc
            .get_page_content(page_id)
            .map_err(|e| format!("Lecture du flux de la page impossible : {e}"))?;
        // `q … Q` isole notre matrice : même si le flux d’origine laisse des
        // `q` non refermés, l’état graphique revient au nôtre à la fin.
        let mut content = Vec::with_capacity(original.len() + 64);
        content.extend_from_slice(b"q\n");
        content.extend_from_slice(placement.matrix.to_cm().as_bytes());
        content.extend_from_slice(b"\n");
        content.extend_from_slice(&original);
        content.extend_from_slice(b"\nQ\n");

        let has_contents = doc
            .get_dictionary(page_id)
            .map(|dict| dict.has(b"Contents"))
            .unwrap_or(false);
        if has_contents {
            doc.change_page_content(page_id, content)
                .map_err(|e| format!("Écriture du flux de la page impossible : {e}"))?;
        } else {
            // Page sans /Contents : on en crée un plutôt que d’échouer.
            let stream_id = doc.add_object(lopdf::Stream::new(lopdf::Dictionary::new(), content));
            if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(page_id) {
                dict.set("Contents", Object::Reference(stream_id));
            }
        }

        transform_annotations(&mut doc, page_id, placement.matrix);

        if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(page_id) {
            dict.set(
                "MediaBox",
                Object::Array(vec![
                    Object::Real(0.0),
                    Object::Real(0.0),
                    Object::Real(sheet_w as f32),
                    Object::Real(sheet_h as f32),
                ]),
            );
            // La rotation est désormais dans la matrice.
            dict.set("Rotate", Object::Integer(0));
            // Un CropBox résiduel (ou hérité) rognerait notre nouvelle feuille.
            for key in ["CropBox", "BleedBox", "TrimBox", "ArtBox"] {
                dict.remove(key.as_bytes());
            }
        }
    }

    // Les mêmes clés posées sur l’arbre /Pages seraient héritées et écraseraient
    // le MediaBox par page : on les neutralise.
    clear_page_tree_attributes(&mut doc);

    let mut out = Vec::new();
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("Enregistrement du PDF imposé impossible : {e}"))?;
    Ok(out)
}

/// Cible du recadrage d’étiquette.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTarget {
    pub width_pt: f64,
    pub height_pt: f64,
    /// Marge blanche conservée sur les quatre bords.
    #[serde(default)]
    pub margin_pt: f64,
    /// Hauteur à laquelle ramener les bandes vides internes. 0 = ne pas
    /// resserrer, on se contente alors du recadrage sur la bbox.
    #[serde(default)]
    pub gutter_pt: f64,
}

/// Ce que le recadrage a produit, pour l’afficher dans le panneau.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelFitResult {
    pub bytes: Vec<u8>,
    /// Échelle appliquée (0,96 = réduit à 96 %).
    pub scale: f64,
    pub source_width_pt: f64,
    pub source_height_pt: f64,
    /// Nombre de bandes vides resserrées, 0 si simple recadrage.
    pub compacted_gutters: usize,
}

/// Hauteur minimale d’une bande vide pour compter comme gouttière (≈ 2,8 mm).
/// En dessous, c’est un interligne : le resserrer collerait deux lignes de texte.
const MIN_GUTTER_PT: f32 = 8.0;
/// Tolérance du clip autour de chaque bande, pour ne pas raser un glyphe.
/// Reste largement dans la gouttière, qui vaut au moins `MIN_GUTTER_PT`.
const BAND_CLIP_SLACK_PT: f64 = 1.0;

/// Recadre chaque page sur son contenu et l’adapte au format d’étiquette.
///
/// Deux effets cumulés, décrits dans `pdf_label` :
///   - suppression des marges blanches (recadrage sur la bounding box) ;
///   - resserrage des bandes vides internes à `gutter_pt`, ce qui récupère la
///     hauteur perdue en interlignes sans supprimer le moindre contenu.
///
/// L’échelle est uniforme (jamais de déformation) et plafonnée à 100 % : une
/// étiquette plus petite que le media n’est pas agrandie.
pub fn fit_label_to_media(bytes: &[u8], target: &LabelTarget) -> Result<LabelFitResult, String> {
    if target.width_pt <= 1.0 || target.height_pt <= 1.0 {
        return Err("Dimensions d’étiquette cible invalides.".into());
    }
    let usable_width = target.width_pt - 2.0 * target.margin_pt.max(0.0);
    let usable_height = target.height_pt - 2.0 * target.margin_pt.max(0.0);
    if usable_width <= 1.0 || usable_height <= 1.0 {
        return Err("Marge trop grande pour le format d’étiquette.".into());
    }

    let mut doc = Document::load_mem(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages: BTreeMap<u32, ObjectId> = doc.get_pages();
    if pages.is_empty() {
        return Err("Le PDF ne contient aucune page.".into());
    }

    let mut min_scale = f64::INFINITY;
    let mut source_width = 0.0_f64;
    let mut source_height = 0.0_f64;
    let mut compacted_gutters = 0_usize;

    for (page_number, page_id) in pages {
        let layout = analyze_label_page(bytes, page_number, 72.0, MIN_GUTTER_PT)?;
        let content_width = layout.content.width() as f64;
        if content_width <= 0.0 {
            return Err(format!("Contenu introuvable sur la page {page_number}."));
        }
        // La première page dicte ce qu’on affiche dans le panneau.
        if source_width == 0.0 {
            source_width = layout.page_width as f64;
            source_height = layout.page_height as f64;
        }

        let bands = usable_bands(&layout, target.gutter_pt);
        let gutter = if bands.len() > 1 { target.gutter_pt } else { 0.0 };
        let ink_height: f64 = bands.iter().map(|band| band.height() as f64).sum();
        let stacked_height = ink_height + gutter * (bands.len() - 1) as f64;
        if stacked_height <= 0.0 {
            return Err(format!("Contenu vide sur la page {page_number}."));
        }

        let scale = (usable_width / content_width)
            .min(usable_height / stacked_height)
            // Jamais d’agrandissement : une étiquette déjà plus petite que le
            // media doit sortir à sa taille.
            .min(1.0);
        min_scale = min_scale.min(scale);
        if bands.len() > 1 {
            compacted_gutters += bands.len() - 1;
        }

        stack_bands_on_page(&mut doc, page_id, &layout, &bands, target, scale)?;
    }

    clear_page_tree_attributes(&mut doc);

    let mut out = Vec::new();
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("Enregistrement de l’étiquette recadrée impossible : {e}"))?;

    Ok(LabelFitResult {
        bytes: out,
        scale: if min_scale.is_finite() { min_scale } else { 1.0 },
        source_width_pt: source_width,
        source_height_pt: source_height,
        compacted_gutters,
    })
}

/// Bandes à empiler : celles du layout si on resserre, sinon un bloc unique
/// couvrant toute la bbox.
fn usable_bands(layout: &LabelLayout, gutter_pt: f64) -> Vec<ContentBand> {
    if gutter_pt <= 0.0 || layout.bands.len() < 2 {
        return vec![ContentBand {
            y0: layout.content.y0,
            y1: layout.content.y1,
        }];
    }
    layout.bands.clone()
}

/// Transforme la page en Form XObject, puis la redessine bande par bande.
fn stack_bands_on_page(
    doc: &mut Document,
    page_id: ObjectId,
    layout: &LabelLayout,
    bands: &[ContentBand],
    target: &LabelTarget,
    scale: f64,
) -> Result<(), String> {
    let media = page_media_box(doc, page_id);
    let resources = inherited_attribute(doc, page_id, b"Resources")
        .and_then(|object| match object {
            Object::Dictionary(dict) => Some(dict),
            _ => None,
        })
        .unwrap_or_default();
    let content = doc
        .get_page_content(page_id)
        .map_err(|e| format!("Lecture du flux de la page impossible : {e}"))?;

    // Le contenu d’origine devient un Form XObject : on peut alors le dessiner
    // plusieurs fois, chaque fois avec un clip et une translation différents.
    let mut form_dict = Dictionary::new();
    form_dict.set("Type", Object::Name(b"XObject".to_vec()));
    form_dict.set("Subtype", Object::Name(b"Form".to_vec()));
    form_dict.set("FormType", Object::Integer(1));
    form_dict.set(
        "BBox",
        Object::Array(vec![
            Object::Real(media.x0 as f32),
            Object::Real(media.y0 as f32),
            Object::Real(media.x1 as f32),
            Object::Real(media.y1 as f32),
        ]),
    );
    form_dict.set("Resources", Object::Dictionary(resources));
    // Le /Rotate de la page n’est pas transmis au Form : on l’absorbe dans les
    // matrices ci-dessous en le laissant à zéro sur la page de sortie.
    let form_id = doc.add_object(Stream::new(form_dict, content));

    let content_width = layout.content.width() as f64;
    let left = (target.width_pt - content_width * scale) / 2.0;
    let mut cursor_top = target.height_pt - target.margin_pt.max(0.0);
    let gutter = if bands.len() > 1 { target.gutter_pt } else { 0.0 };

    let mut stream = Vec::new();
    // Du haut vers le bas : le contenu est calé en haut de l’étiquette.
    for band in bands.iter().rev() {
        let band_height = band.height() as f64 * scale;
        let bottom = cursor_top - band_height;
        let translate_x = left - layout.content.x0 as f64 * scale;
        let translate_y = bottom - band.y0 as f64 * scale;

        stream.extend_from_slice(b"q\n");
        stream.extend_from_slice(
            format!(
                "{:.4} {:.4} {:.4} {:.4} re W n\n",
                left - BAND_CLIP_SLACK_PT,
                bottom - BAND_CLIP_SLACK_PT,
                content_width * scale + 2.0 * BAND_CLIP_SLACK_PT,
                band_height + 2.0 * BAND_CLIP_SLACK_PT
            )
            .as_bytes(),
        );
        stream.extend_from_slice(
            format!("{scale:.5} 0 0 {scale:.5} {translate_x:.4} {translate_y:.4} cm\n").as_bytes(),
        );
        stream.extend_from_slice(b"/AltoLabelForm Do\nQ\n");

        cursor_top = bottom - gutter * scale;
    }

    let content_id = doc.add_object(Stream::new(Dictionary::new(), stream));

    let mut xobjects = Dictionary::new();
    xobjects.set("AltoLabelForm", Object::Reference(form_id));
    let mut page_resources = Dictionary::new();
    page_resources.set("XObject", Object::Dictionary(xobjects));

    if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(page_id) {
        dict.set("Contents", Object::Reference(content_id));
        dict.set("Resources", Object::Dictionary(page_resources));
        dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(target.width_pt as f32),
                Object::Real(target.height_pt as f32),
            ]),
        );
        dict.set("Rotate", Object::Integer(0));
        for key in ["CropBox", "BleedBox", "TrimBox", "ArtBox"] {
            dict.remove(key.as_bytes());
        }
        // Les annotations ne suivent pas un découpage en bandes : les garder
        // les placerait n’importe où sur l’étiquette.
        dict.remove(b"Annots");
    }
    Ok(())
}

/// Neutralise les attributs héritables de l’arbre `/Pages`, qui écraseraient
/// le MediaBox posé page par page.
fn clear_page_tree_attributes(doc: &mut Document) {
    let page_tree_ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter(|(_, object)| {
            matches!(object, Object::Dictionary(dict)
                if dict.get(b"Type").and_then(|t| t.as_name()).map(|n| n == b"Pages").unwrap_or(false))
        })
        .map(|(id, _)| *id)
        .collect();
    for id in page_tree_ids {
        if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(id) {
            for key in ["MediaBox", "CropBox", "Rotate"] {
                dict.remove(key.as_bytes());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LABEL_4X6: (f64, f64) = (288.0, 432.0);

    fn rect(w: f64, h: f64) -> Rect {
        Rect::new(0.0, 0.0, w, h)
    }

    fn approx(left: f64, right: f64) {
        assert!(
            (left - right).abs() < 0.01,
            "attendu {right}, obtenu {left}"
        );
    }

    #[test]
    fn actual_keeps_scale_and_centers() {
        let placement = place_page(
            rect(288.0, 432.0),
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Actual,
            Orientation::Auto,
        );
        approx(placement.scale, 1.0);
        // Page identique à la feuille : aucun décalage.
        approx(placement.matrix.e, 0.0);
        approx(placement.matrix.f, 0.0);
    }

    #[test]
    fn actual_centers_oversized_page_instead_of_anchoring() {
        // Le label DHL réel : 110 × 210 mm sur une 4×6.
        let placement = place_page(
            rect(311.8, 595.3),
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Actual,
            Orientation::Portrait,
        );
        approx(placement.scale, 1.0);
        // Débordement symétrique : c’est le comportement Acrobat, pas
        // l’ancrage en bas à gauche du driver.
        approx(placement.matrix.e, (288.0 - 311.8) / 2.0);
        approx(placement.matrix.f, (432.0 - 595.3) / 2.0);
    }

    #[test]
    fn fit_shrinks_dhl_label_to_4x6() {
        let placement = place_page(
            rect(311.8, 595.3),
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Fit,
            Orientation::Portrait,
        );
        // min(288/311.8, 432/595.3) = 0.7257 — la hauteur est le facteur limitant.
        approx(placement.scale, 432.0 / 595.3);
        // Le contenu tient entièrement dans la feuille.
        let (x1, y1) = placement.matrix.apply(311.8, 595.3);
        assert!(x1 <= 288.0 + 0.01, "débordement en largeur : {x1}");
        assert!(y1 <= 432.0 + 0.01, "débordement en hauteur : {y1}");
        let (x0, y0) = placement.matrix.apply(0.0, 0.0);
        assert!(x0 >= -0.01 && y0 >= -0.01, "origine hors feuille");
    }

    #[test]
    fn fit_enlarges_small_page_but_shrink_does_not() {
        let small = rect(144.0, 216.0);
        let fit = place_page(
            small,
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Fit,
            Orientation::Portrait,
        );
        approx(fit.scale, 2.0);
        let shrink = place_page(
            small,
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Shrink,
            Orientation::Portrait,
        );
        approx(shrink.scale, 1.0);
    }

    #[test]
    fn fill_covers_sheet() {
        let placement = place_page(
            rect(311.8, 595.3),
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Fill,
            Orientation::Portrait,
        );
        approx(placement.scale, 288.0 / 311.8);
        // Couverture complète : les deux dimensions atteignent au moins la feuille.
        let (x1, y1) = placement.matrix.apply(311.8, 595.3);
        let (x0, y0) = placement.matrix.apply(0.0, 0.0);
        assert!(x1 - x0 >= 288.0 - 0.01);
        assert!(y1 - y0 >= 432.0 - 0.01);
    }

    #[test]
    fn custom_scale_is_percentage() {
        let placement = place_page(
            rect(288.0, 432.0),
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Custom(50.0),
            Orientation::Portrait,
        );
        approx(placement.scale, 0.5);
        // Moitié de la feuille, centrée.
        approx(placement.matrix.e, 72.0);
        approx(placement.matrix.f, 108.0);
    }

    #[test]
    fn non_zero_origin_media_box_is_normalized() {
        // MediaBox décalé : le contenu doit malgré tout arriver à l’origine.
        let offset = Rect::new(20.0, 30.0, 308.0, 462.0);
        let placement = place_page(
            offset,
            0,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Actual,
            Orientation::Portrait,
        );
        let (x, y) = placement.matrix.apply(20.0, 30.0);
        approx(x, 0.0);
        approx(y, 0.0);
    }

    #[test]
    fn rotate_90_is_absorbed_into_matrix() {
        // Page 432×288 avec /Rotate 90 : le lecteur l’affiche en 288×432,
        // donc elle tient pile sur une 4×6 portrait sans mise à l’échelle.
        let placement = place_page(
            rect(432.0, 288.0),
            90,
            LABEL_4X6.0,
            LABEL_4X6.1,
            ScaleMode::Fit,
            Orientation::Auto,
        );
        approx(placement.scale, 1.0);
        assert_eq!(placement.rotation, 90);
        // Les quatre coins retombent dans la feuille.
        for (x, y) in [(0.0, 0.0), (432.0, 0.0), (432.0, 288.0), (0.0, 288.0)] {
            let (tx, ty) = placement.matrix.apply(x, y);
            assert!(
                tx >= -0.01 && tx <= 288.01 && ty >= -0.01 && ty <= 432.01,
                "coin hors feuille : ({tx}, {ty})"
            );
        }
    }

    #[test]
    fn rotate_180_and_270_stay_inside_sheet() {
        for rotation in [180, 270] {
            let placement = place_page(
                rect(288.0, 432.0),
                rotation,
                LABEL_4X6.0,
                LABEL_4X6.1,
                ScaleMode::Fit,
                Orientation::Portrait,
            );
            for (x, y) in [(0.0, 0.0), (288.0, 0.0), (288.0, 432.0), (0.0, 432.0)] {
                let (tx, ty) = placement.matrix.apply(x, y);
                assert!(
                    tx >= -0.01 && tx <= 288.01 && ty >= -0.01 && ty <= 432.01,
                    "rotation {rotation} : coin hors feuille ({tx}, {ty})"
                );
            }
        }
    }

    #[test]
    fn auto_orientation_turns_landscape_page_on_portrait_sheet() {
        // A4 paysage sur feuille A4 portrait : quart de tour + échelle 1.
        let placement = place_page(
            rect(841.89, 595.28),
            0,
            595.28,
            841.89,
            ScaleMode::Fit,
            Orientation::Auto,
        );
        approx(placement.scale, 1.0);
        assert_eq!(placement.rotation, 90);
    }

    #[test]
    fn portrait_orientation_never_turns_the_page() {
        let placement = place_page(
            rect(841.89, 595.28),
            0,
            595.28,
            841.89,
            ScaleMode::Fit,
            Orientation::Portrait,
        );
        assert_eq!(placement.rotation, 0);
        // Sans rotation, il faut réduire pour tenir en largeur.
        approx(placement.scale, 595.28 / 841.89);
    }

    #[test]
    fn invalid_rotation_falls_back_to_zero() {
        assert_eq!(normalize_rotation(45), 0);
        assert_eq!(normalize_rotation(-90), 270);
        assert_eq!(normalize_rotation(450), 90);
        assert_eq!(normalize_rotation(360), 0);
    }

    fn minimal_pdf(media_box: &str, rotate: Option<i64>) -> Vec<u8> {
        let content = b"0 0 1 rg 10 10 100 100 re f";
        let rotate_entry = rotate.map(|r| format!(" /Rotate {r}")).unwrap_or_default();
        let objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Count 1 /Kids [3 0 R] >>".to_string(),
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox {media_box}{rotate_entry} /Contents 4 0 R >>"
            ),
            format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                content.len(),
                String::from_utf8_lossy(content)
            ),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in &offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref
            )
            .as_bytes(),
        );
        out
    }

    #[test]
    fn impose_rewrites_media_box_to_sheet() {
        let pdf = minimal_pdf("[0 0 311.8 595.3]", None);
        let imposed = impose(
            &pdf,
            &Imposition {
                sheet_width_pts: 288.0,
                sheet_height_pts: 432.0,
                mode: ScaleMode::Fit,
                orientation: Orientation::Portrait,
            },
        )
        .expect("imposition");

        let doc = Document::load_mem(&imposed).expect("relecture");
        let page_id = *doc.get_pages().values().next().expect("une page");
        let media = page_media_box(&doc, page_id);
        approx(media.width(), 288.0);
        approx(media.height(), 432.0);
        assert_eq!(page_rotation(&doc, page_id), 0);

        // La matrice a bien été injectée devant le contenu d’origine.
        let content = String::from_utf8_lossy(&doc.get_page_content(page_id).expect("flux")).to_string();
        assert!(content.starts_with('q'), "flux non encapsulé : {content:.40}");
        assert!(content.contains(" cm"), "matrice absente");
        assert!(content.contains("100 100 re"), "contenu d’origine perdu");
        assert!(content.trim_end().ends_with('Q'), "état graphique non restauré");
    }

    #[test]
    fn impose_absorbs_page_rotation() {
        let pdf = minimal_pdf("[0 0 432 288]", Some(90));
        let imposed = impose(
            &pdf,
            &Imposition {
                sheet_width_pts: 288.0,
                sheet_height_pts: 432.0,
                mode: ScaleMode::Fit,
                orientation: Orientation::Auto,
            },
        )
        .expect("imposition");
        let doc = Document::load_mem(&imposed).expect("relecture");
        let page_id = *doc.get_pages().values().next().expect("une page");
        // /Rotate remis à zéro puisque la rotation est dans la matrice.
        assert_eq!(page_rotation(&doc, page_id), 0);
        let media = page_media_box(&doc, page_id);
        approx(media.width(), 288.0);
        approx(media.height(), 432.0);
    }

    #[test]
    fn impose_rejects_absurd_sheet() {
        let pdf = minimal_pdf("[0 0 288 432]", None);
        assert!(impose(
            &pdf,
            &Imposition {
                sheet_width_pts: 0.0,
                sheet_height_pts: 432.0,
                mode: ScaleMode::Fit,
                orientation: Orientation::Auto,
            },
        )
        .is_err());
    }
}
