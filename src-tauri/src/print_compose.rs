//! Composition des feuilles imprimées : sélection des pages, plusieurs pages
//! par feuille, livret, affiche en mosaïque et ordre inversé.
//!
//! Même raison d’être que `print_layout::place_page` : sur macOS, la chaîne
//! CUPS ignore une partie des options de mise en page (`number-up`,
//! `page-set`, `print-scaling`…) sans le signaler. Chaque feuille est donc
//! construite ici : chaque page source devient un Form XObject, dessiné autant
//! de fois que la mise en page le demande, sur des pages qui font déjà la
//! taille du papier. Le driver n’a plus rien à décider, et l’aperçu du panneau
//! affiche ce PDF-là.

use std::collections::{BTreeSet, HashMap};

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::print_layout::{
    clear_page_tree_attributes, inherited_attribute, object_to_f64, page_media_box,
    page_rotation, place_page, rect_from_object, Matrix, Orientation, Rect, ScaleMode,
};

const MM_TO_PT: f64 = 72.0 / 25.4;
/// Grille personnalisée : au-delà, les pages deviennent illisibles.
const MAX_GRID: u32 = 10;
/// Feuilles d’affiche par page source : au-delà, c’est presque toujours une
/// échelle saisie par erreur, et l’envoi pèserait des centaines de pages.
const MAX_POSTER_TILES: u32 = 400;
const CUT_MARK_PT: f64 = 14.0;
const LABEL_FONT_PT: f64 = 7.0;
const BORDER_WIDTH_PT: f64 = 0.6;
/// Attributs héritables à recopier sur une page avant de la rattacher
/// directement à la racine de l’arbre.
const INHERITABLE_KEYS: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Parity {
    All,
    Odd,
    Even,
}

impl Parity {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "" | "all" => Ok(Self::All),
            "odd" => Ok(Self::Odd),
            "even" => Ok(Self::Even),
            other => Err(format!("Sous-ensemble de pages inconnu : {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PageOrder {
    Horizontal,
    HorizontalReversed,
    Vertical,
    VerticalReversed,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Grid {
    /// 2, 4, 6, 9 ou 16 : le sens de la grille est choisi au mieux.
    Preset(u32),
    Custom { columns: u32, rows: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BookletSubset {
    Both,
    Front,
    Back,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Binding {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Layout {
    Single {
        mode: ScaleMode,
        orientation: Orientation,
    },
    Multiple {
        grid: Grid,
        order: PageOrder,
        borders: bool,
        auto_rotate: bool,
        orientation: Orientation,
    },
    Booklet {
        subset: BookletSubset,
        binding: Binding,
    },
    Poster {
        scale_pct: f64,
        overlap_pt: f64,
        cut_marks: bool,
        labels: bool,
        orientation: Orientation,
    },
}

impl Layout {
    /// Valeur IPP `sides` que la mise en page impose, quel que soit le panneau.
    ///
    /// Un livret recto verso ne se plie correctement qu’avec un retournement
    /// sur le bord court : les deux faces d’une planche partagent alors le
    /// même haut. Recto seul ou verso seul, c’est un passage simple face.
    pub fn forced_sides(&self) -> Option<&'static str> {
        match self {
            Layout::Booklet {
                subset: BookletSubset::Both,
                ..
            } => Some("two-sided-short-edge"),
            Layout::Booklet { .. } => Some("one-sided"),
            _ => None,
        }
    }
}

/// Réglages de mise en page tels que le panneau d’impression les envoie.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutOptions {
    /// `size` | `multiple` | `poster` | `booklet`. Vide = `size`.
    pub kind: String,
    /// 2, 4, 6, 9 ou 16 ; 0 = grille personnalisée `columns` × `rows`.
    pub pages_per_sheet: u32,
    pub columns: u32,
    pub rows: u32,
    /// `horizontal` | `horizontal-reversed` | `vertical` | `vertical-reversed`
    pub page_order: String,
    pub borders: bool,
    pub auto_rotate: bool,
    /// Échelle de l’affiche, en pourcentage de la page source.
    pub tile_scale: f64,
    pub overlap_mm: f64,
    pub cut_marks: bool,
    pub labels: bool,
    /// `both` | `front` | `back`
    pub booklet_subset: String,
    /// `left` | `right`
    pub booklet_binding: String,
}

impl LayoutOptions {
    pub fn resolve(&self, mode: ScaleMode, orientation: Orientation) -> Result<Layout, String> {
        match self.kind.as_str() {
            "" | "size" => Ok(Layout::Single { mode, orientation }),
            "multiple" => {
                let grid = match self.pages_per_sheet {
                    0 => {
                        let valid = 1..=MAX_GRID;
                        if !valid.contains(&self.columns) || !valid.contains(&self.rows) {
                            return Err(format!(
                                "Grille invalide : de 1 à {MAX_GRID} colonnes et rangées."
                            ));
                        }
                        Grid::Custom {
                            columns: self.columns,
                            rows: self.rows,
                        }
                    }
                    n @ (2 | 4 | 6 | 9 | 16) => Grid::Preset(n),
                    other => return Err(format!("Nombre de pages par feuille invalide : {other}")),
                };
                let order = match self.page_order.as_str() {
                    "" | "horizontal" => PageOrder::Horizontal,
                    "horizontal-reversed" => PageOrder::HorizontalReversed,
                    "vertical" => PageOrder::Vertical,
                    "vertical-reversed" => PageOrder::VerticalReversed,
                    other => return Err(format!("Ordre des pages inconnu : {other}")),
                };
                Ok(Layout::Multiple {
                    grid,
                    order,
                    borders: self.borders,
                    auto_rotate: self.auto_rotate,
                    orientation,
                })
            }
            "booklet" => {
                let subset = match self.booklet_subset.as_str() {
                    "" | "both" => BookletSubset::Both,
                    "front" => BookletSubset::Front,
                    "back" => BookletSubset::Back,
                    other => return Err(format!("Sous-ensemble de livret inconnu : {other}")),
                };
                let binding = match self.booklet_binding.as_str() {
                    "" | "left" => Binding::Left,
                    "right" => Binding::Right,
                    other => return Err(format!("Reliure de livret inconnue : {other}")),
                };
                Ok(Layout::Booklet { subset, binding })
            }
            "poster" => {
                if !self.tile_scale.is_finite() || !(1.0..=1000.0).contains(&self.tile_scale) {
                    return Err("Échelle de l’affiche invalide (1 à 1000 %).".into());
                }
                if !self.overlap_mm.is_finite() || !(0.0..=50.0).contains(&self.overlap_mm) {
                    return Err("Chevauchement invalide (0 à 50 mm).".into());
                }
                Ok(Layout::Poster {
                    scale_pct: self.tile_scale,
                    overlap_pt: self.overlap_mm * MM_TO_PT,
                    cut_marks: self.cut_marks,
                    labels: self.labels,
                    orientation,
                })
            }
            other => Err(format!("Mise en page inconnue : {other}")),
        }
    }
}

/// Pages à imprimer : plage (syntaxe `1-3,5`, `8-`) puis paires ou impaires.
#[derive(Debug, Clone, Copy)]
pub struct PageSelection<'a> {
    pub range: Option<&'a str>,
    pub parity: Parity,
}

impl PageSelection<'_> {
    pub fn is_everything(&self) -> bool {
        self.parity == Parity::All && self.range.map(str::trim).is_none_or(str::is_empty)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ComposeRequest<'a> {
    pub sheet_width_pts: f64,
    pub sheet_height_pts: f64,
    pub selection: PageSelection<'a>,
    pub layout: Layout,
    pub reverse: bool,
    /// Recto verso : l’ordre inversé déplace alors les feuilles, pas les faces.
    pub two_sided: bool,
}

#[derive(Debug, Clone)]
pub struct Composition {
    pub bytes: Vec<u8>,
    /// Faces imprimées, sans la face blanche éventuellement ajoutée pour
    /// garder les paires recto verso en ordre inversé.
    pub sheets: usize,
    /// Grille de l’affiche pour la première page, `(colonnes, rangées)`.
    pub poster_grid: Option<(u32, u32)>,
    /// Pour chaque page produite : contenu couché d’un quart de tour sur le
    /// papier (haut vers la droite). L’aperçu s’en sert pour le redresser.
    pub turned: Vec<bool>,
}

/// Plage de pages au format CUPS, bornée au nombre de pages du document.
pub fn parse_page_range(spec: &str, total: u32) -> Result<BTreeSet<u32>, String> {
    let invalid = || "Plage de pages invalide (ex. 1-3,5).".to_string();
    let number = |text: &str| text.trim().parse::<u32>().map_err(|_| invalid());
    let mut pages = BTreeSet::new();
    for token in spec.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        let (first, last) = match token.split_once('-') {
            Some((start, end)) => {
                let first = if start.trim().is_empty() { 1 } else { number(start)? };
                let last = if end.trim().is_empty() { total } else { number(end)? };
                (first, last)
            }
            None => {
                let page = number(token)?;
                (page, page)
            }
        };
        if first == 0 || last < first {
            return Err(invalid());
        }
        pages.extend(first..=last.min(total));
    }
    Ok(pages)
}

fn selected_pages(doc: &Document, selection: &PageSelection) -> Result<Vec<(u32, ObjectId)>, String> {
    let pages = doc.get_pages();
    let total = pages.len() as u32;
    let wanted = match selection.range.map(str::trim).filter(|s| !s.is_empty()) {
        Some(spec) => Some(parse_page_range(spec, total)?),
        None => None,
    };
    let chosen: Vec<(u32, ObjectId)> = pages
        .into_iter()
        .filter(|(number, _)| wanted.as_ref().is_none_or(|set| set.contains(number)))
        .filter(|(number, _)| match selection.parity {
            Parity::All => true,
            Parity::Odd => number % 2 == 1,
            Parity::Even => number % 2 == 0,
        })
        .collect();
    if chosen.is_empty() {
        return Err("Aucune page à imprimer avec cette sélection.".into());
    }
    Ok(chosen)
}

#[derive(Debug, Clone, Copy)]
struct SourcePage {
    number: u32,
    id: ObjectId,
    /// Zone visible (CropBox ∩ MediaBox), en espace utilisateur de la page.
    visible: Rect,
    rotate: i64,
}

impl SourcePage {
    /// Dimensions telles que le lecteur les affiche, `/Rotate` appliqué.
    fn displayed_size(&self) -> (f64, f64) {
        match self.rotate.rem_euclid(360) {
            90 | 270 => (self.visible.height(), self.visible.width()),
            _ => (self.visible.width(), self.visible.height()),
        }
    }
}

/// La zone que les lecteurs et les imprimantes montrent : le CropBox, borné
/// au MediaBox. L’aperçu pdf.js du panneau part de la même zone.
fn visible_box(doc: &Document, page_id: ObjectId) -> Rect {
    let media = page_media_box(doc, page_id);
    let Some(crop) =
        inherited_attribute(doc, page_id, b"CropBox").and_then(|o| rect_from_object(doc, &o))
    else {
        return media;
    };
    let (x0, y0) = (crop.x0.max(media.x0), crop.y0.max(media.y0));
    let (x1, y1) = (crop.x1.min(media.x1), crop.y1.min(media.y1));
    if x1 - x0 > 1.0 && y1 - y0 > 1.0 {
        Rect::new(x0, y0, x1, y1)
    } else {
        media
    }
}

const IDENTITY: Matrix = Matrix {
    a: 1.0,
    b: 0.0,
    c: 0.0,
    d: 1.0,
    e: 0.0,
    f: 0.0,
};

/// `first` puis `then`.
fn concat(first: Matrix, then: Matrix) -> Matrix {
    Matrix {
        a: then.a * first.a + then.c * first.b,
        b: then.b * first.a + then.d * first.b,
        c: then.a * first.c + then.c * first.d,
        d: then.b * first.c + then.d * first.d,
        e: then.a * first.e + then.c * first.f + then.e,
        f: then.b * first.e + then.d * first.f + then.f,
    }
}

fn translate(x: f64, y: f64) -> Matrix {
    Matrix {
        e: x,
        f: y,
        ..IDENTITY
    }
}

/// Feuille sur laquelle on compose, éventuellement tournée d’un quart de tour
/// par rapport au papier : le haut de la feuille virtuelle va à droite du
/// papier. Les pages produites gardent toujours l’orientation du media.
#[derive(Debug, Clone, Copy)]
struct Frame {
    width: f64,
    height: f64,
    turn: Option<Matrix>,
}

impl Frame {
    fn new(sheet_width: f64, sheet_height: f64, turned: bool) -> Self {
        if turned {
            Frame {
                width: sheet_height,
                height: sheet_width,
                turn: Some(Matrix {
                    a: 0.0,
                    b: -1.0,
                    c: 1.0,
                    d: 0.0,
                    e: 0.0,
                    f: sheet_height,
                }),
            }
        } else {
            Frame {
                width: sheet_width,
                height: sheet_height,
                turn: None,
            }
        }
    }

    fn to_sheet(self, matrix: Matrix) -> Matrix {
        match self.turn {
            Some(turn) => concat(matrix, turn),
            None => matrix,
        }
    }

    /// Feuilles candidates pour une orientation : `Auto` laisse le choix.
    fn candidates(sheet_width: f64, sheet_height: f64, orientation: Orientation) -> Vec<Frame> {
        let square = (sheet_width - sheet_height).abs() < 0.5;
        let portrait_sheet = sheet_width < sheet_height;
        match orientation {
            Orientation::Auto if square => vec![Frame::new(sheet_width, sheet_height, false)],
            Orientation::Auto => vec![
                Frame::new(sheet_width, sheet_height, false),
                Frame::new(sheet_width, sheet_height, true),
            ],
            Orientation::Portrait => {
                vec![Frame::new(sheet_width, sheet_height, !square && !portrait_sheet)]
            }
            Orientation::Landscape => {
                vec![Frame::new(sheet_width, sheet_height, !square && portrait_sheet)]
            }
        }
    }
}

struct Placed {
    source: usize,
    matrix: Matrix,
    border: bool,
}

#[derive(Default)]
struct SheetSpec {
    items: Vec<Placed>,
    /// Opérateurs dessinés par-dessus, déjà en coordonnées du papier.
    overlay: String,
    needs_font: bool,
    turned: bool,
}

fn layout_single(
    sources: &[SourcePage],
    sheet: (f64, f64),
    mode: ScaleMode,
    orientation: Orientation,
) -> Vec<SheetSpec> {
    sources
        .iter()
        .enumerate()
        .map(|(index, page)| SheetSpec {
            items: vec![Placed {
                source: index,
                matrix: place_page(page.visible, page.rotate, sheet.0, sheet.1, mode, orientation)
                    .matrix,
                border: false,
            }],
            ..SheetSpec::default()
        })
        .collect()
}

fn grid_candidates(grid: Grid) -> Vec<(u32, u32)> {
    match grid {
        Grid::Custom { columns, rows } => vec![(columns, rows)],
        Grid::Preset(count) => {
            let (columns, rows) = match count {
                2 => (2, 1),
                4 => (2, 2),
                6 => (3, 2),
                9 => (3, 3),
                _ => (4, 4),
            };
            if columns == rows {
                vec![(columns, rows)]
            } else {
                vec![(columns, rows), (rows, columns)]
            }
        }
    }
}

fn layout_multiple(
    sources: &[SourcePage],
    sheet: (f64, f64),
    grid: Grid,
    order: PageOrder,
    borders: bool,
    auto_rotate: bool,
    orientation: Orientation,
) -> Vec<SheetSpec> {
    let cell_orientation = if auto_rotate {
        Orientation::Auto
    } else {
        Orientation::Portrait
    };
    // La grille et le sens de la feuille qui donnent la plus grande première
    // page : 2 pages A4 portrait vont côte à côte sur une feuille couchée,
    // pas l’une sur l’autre à 50 %. À taille égale, on garde les pages droites
    // dans leur case : l’ordre de lecture suit alors celui de la feuille.
    let first = sources[0];
    let upright_rotation = match first.rotate.rem_euclid(360) {
        rotation @ (90 | 180 | 270) => rotation,
        _ => 0,
    };
    let mut best = (Frame::new(sheet.0, sheet.1, false), 1, 1, f64::NEG_INFINITY, false);
    for frame in Frame::candidates(sheet.0, sheet.1, orientation) {
        for (columns, rows) in grid_candidates(grid) {
            let placed = place_page(
                first.visible,
                first.rotate,
                frame.width / columns as f64,
                frame.height / rows as f64,
                ScaleMode::Fit,
                cell_orientation,
            );
            let upright = placed.rotation == upright_rotation;
            let larger = placed.scale > best.3 + 1e-6;
            let same_size = (placed.scale - best.3).abs() <= 1e-6;
            if larger || (same_size && upright && !best.4) {
                best = (frame, columns, rows, placed.scale, upright);
            }
        }
    }
    let (frame, columns, rows, _, _) = best;
    let per_sheet = (columns * rows) as usize;
    let cell_width = frame.width / columns as f64;
    let cell_height = frame.height / rows as f64;

    sources
        .chunks(per_sheet)
        .enumerate()
        .map(|(sheet_index, chunk)| {
            let items = chunk
                .iter()
                .enumerate()
                .map(|(slot, page)| {
                    let slot_u = slot as u32;
                    let (column, row) = match order {
                        PageOrder::Horizontal => (slot_u % columns, slot_u / columns),
                        PageOrder::HorizontalReversed => {
                            (columns - 1 - slot_u % columns, slot_u / columns)
                        }
                        PageOrder::Vertical => (slot_u / rows, slot_u % rows),
                        PageOrder::VerticalReversed => (columns - 1 - slot_u / rows, slot_u % rows),
                    };
                    let origin_x = column as f64 * cell_width;
                    let origin_y = frame.height - (row + 1) as f64 * cell_height;
                    let placed = place_page(
                        page.visible,
                        page.rotate,
                        cell_width,
                        cell_height,
                        ScaleMode::Fit,
                        cell_orientation,
                    );
                    Placed {
                        source: sheet_index * per_sheet + slot,
                        matrix: frame.to_sheet(concat(placed.matrix, translate(origin_x, origin_y))),
                        border: borders,
                    }
                })
                .collect();
            SheetSpec {
                items,
                turned: frame.turn.is_some(),
                ..SheetSpec::default()
            }
        })
        .collect()
}

/// Faces du livret, chacune `(page de gauche, page de droite)` en index
/// de pages sources ; un index au-delà du document est une page blanche.
fn booklet_sides(page_count: usize, subset: BookletSubset, binding: Binding) -> Vec<(usize, usize)> {
    let padded = page_count.div_ceil(4) * 4;
    let mut sides = Vec::with_capacity(padded / 2);
    for sheet in 0..padded / 4 {
        let front = (padded - 1 - 2 * sheet, 2 * sheet);
        let back = (2 * sheet + 1, padded - 2 - 2 * sheet);
        let (front, back) = match binding {
            Binding::Left => (front, back),
            Binding::Right => ((front.1, front.0), (back.1, back.0)),
        };
        match subset {
            BookletSubset::Both => {
                sides.push(front);
                sides.push(back);
            }
            BookletSubset::Front => sides.push(front),
            BookletSubset::Back => sides.push(back),
        }
    }
    sides
}

fn layout_booklet(
    sources: &[SourcePage],
    sheet: (f64, f64),
    subset: BookletSubset,
    binding: Binding,
) -> Vec<SheetSpec> {
    // Une planche est toujours couchée : deux pages côte à côte, pli au milieu.
    let frame = Frame::new(sheet.0, sheet.1, sheet.0 < sheet.1);
    let half = frame.width / 2.0;
    booklet_sides(sources.len(), subset, binding)
        .into_iter()
        .map(|(left, right)| {
            let items = [(0.0, left), (half, right)]
                .into_iter()
                .filter(|(_, index)| *index < sources.len())
                .map(|(origin_x, index)| {
                    let page = sources[index];
                    let placed = place_page(
                        page.visible,
                        page.rotate,
                        half,
                        frame.height,
                        ScaleMode::Fit,
                        Orientation::Auto,
                    );
                    Placed {
                        source: index,
                        matrix: frame.to_sheet(concat(placed.matrix, translate(origin_x, 0.0))),
                        border: false,
                    }
                })
                .collect();
            SheetSpec {
                items,
                turned: frame.turn.is_some(),
                ..SheetSpec::default()
            }
        })
        .collect()
}

fn poster_grid(width: f64, height: f64, frame: Frame, overlap: f64) -> (u32, u32) {
    // La tolérance évite une colonne de plus pour un arrondi : 2 × 595,28 pt
    // doit donner 2 feuilles, pas 3.
    let count = |size: f64, sheet: f64| {
        if size <= sheet + 0.01 {
            1
        } else {
            (((size - overlap) / (sheet - overlap)) - 1e-6).ceil() as u32
        }
    };
    (count(width, frame.width), count(height, frame.height))
}

fn row_letters(index: u32) -> String {
    let mut letters = Vec::new();
    let mut rest = index;
    loop {
        letters.push(char::from(b'A' + (rest % 26) as u8));
        if rest < 26 {
            break;
        }
        rest = rest / 26 - 1;
    }
    letters.iter().rev().collect()
}

/// Repères de coupe et étiquette d’une feuille d’affiche.
///
/// Le repère marque où couper la bande de recouvrement (à gauche et en haut,
/// côté feuille précédente). L’étiquette va en bas à droite, dans la zone que
/// la feuille suivante recouvre une fois l’affiche assemblée.
fn tile_overlay(
    frame: Frame,
    tile: (u32, u32),
    overlap: f64,
    cut_marks: bool,
    label: Option<String>,
) -> String {
    let (column, row) = tile;
    let mut ops = String::new();
    if cut_marks && overlap > 0.0 && (column > 0 || row > 0) {
        ops.push_str(&format!("0 G {BORDER_WIDTH_PT} w\n"));
        if column > 0 {
            let x = overlap;
            ops.push_str(&format!(
                "{x:.2} {:.2} m {x:.2} {:.2} l S\n{x:.2} 0 m {x:.2} {CUT_MARK_PT:.2} l S\n",
                frame.height,
                frame.height - CUT_MARK_PT
            ));
        }
        if row > 0 {
            let y = frame.height - overlap;
            ops.push_str(&format!(
                "0 {y:.2} m {CUT_MARK_PT:.2} {y:.2} l S\n{:.2} {y:.2} m {:.2} {y:.2} l S\n",
                frame.width - CUT_MARK_PT,
                frame.width
            ));
        }
    }
    if let Some(text) = label {
        let width = text.len() as f64 * LABEL_FONT_PT * 0.56;
        let x = frame.width - width - 8.0;
        let y = 6.0;
        ops.push_str(&format!(
            "1 g {:.2} {:.2} {:.2} {:.2} re f\n0 g BT /SlateLabel {LABEL_FONT_PT} Tf {x:.2} {y:.2} Td ({text}) Tj ET\n",
            x - 2.0,
            y - 2.0,
            width + 4.0,
            LABEL_FONT_PT + 3.0
        ));
    }
    if ops.is_empty() {
        return ops;
    }
    match frame.turn {
        Some(turn) => format!("q\n{}\n{ops}Q\n", turn.to_cm()),
        None => format!("q\n{ops}Q\n"),
    }
}

struct PosterSettings {
    scale_pct: f64,
    overlap_pt: f64,
    cut_marks: bool,
    labels: bool,
    orientation: Orientation,
}

fn layout_poster(
    sources: &[SourcePage],
    sheet: (f64, f64),
    settings: &PosterSettings,
) -> Result<(Vec<SheetSpec>, (u32, u32)), String> {
    let overlap = settings.overlap_pt;
    let factor = settings.scale_pct / 100.0;
    let mut sheets = Vec::new();
    let mut first_grid = None;
    for (index, page) in sources.iter().enumerate() {
        let (displayed_w, displayed_h) = page.displayed_size();
        let (poster_w, poster_h) = (displayed_w * factor, displayed_h * factor);

        let mut best: Option<(Frame, u32, u32)> = None;
        for frame in Frame::candidates(sheet.0, sheet.1, settings.orientation) {
            if overlap * 2.0 >= frame.width.min(frame.height) {
                return Err("Chevauchement trop grand pour ce format de papier.".into());
            }
            let (columns, rows) = poster_grid(poster_w, poster_h, frame, overlap);
            if best.is_none_or(|(_, c, r)| columns * rows < c * r) {
                best = Some((frame, columns, rows));
            }
        }
        let Some((frame, columns, rows)) = best else {
            return Err("Format de papier invalide pour l’affiche.".into());
        };
        if columns * rows > MAX_POSTER_TILES {
            return Err(format!(
                "Affiche trop grande : {} feuilles pour la page {}. Réduis l’échelle.",
                columns * rows,
                page.number
            ));
        }
        first_grid.get_or_insert((columns, rows));

        let step_x = frame.width - overlap;
        let step_y = frame.height - overlap;
        let extent_w = columns as f64 * step_x + overlap;
        let extent_h = rows as f64 * step_y + overlap;
        let base = place_page(
            page.visible,
            page.rotate,
            poster_w,
            poster_h,
            ScaleMode::Custom(settings.scale_pct),
            Orientation::Portrait,
        )
        .matrix;
        // L’affiche est centrée sur la mosaïque : la marge perdue se répartit
        // sur les quatre bords au lieu de s’accumuler à droite et en bas.
        let centered = concat(
            base,
            translate((extent_w - poster_w) / 2.0, (extent_h - poster_h) / 2.0),
        );
        for row in 0..rows {
            for column in 0..columns {
                let tile_x = column as f64 * step_x;
                let tile_y = extent_h - row as f64 * step_y - frame.height;
                let label = settings
                    .labels
                    .then(|| format!("{} / {}{}", page.number, row_letters(row), column + 1));
                sheets.push(SheetSpec {
                    items: vec![Placed {
                        source: index,
                        matrix: frame.to_sheet(concat(centered, translate(-tile_x, -tile_y))),
                        border: false,
                    }],
                    overlay: tile_overlay(frame, (column, row), overlap, settings.cut_marks, label),
                    needs_font: settings.labels,
                    turned: frame.turn.is_some(),
                });
            }
        }
    }
    Ok((sheets, first_grid.unwrap_or((1, 1))))
}

/// Comme `inherited_attribute`, mais sans déréférencer : une ressource
/// partagée reste une référence au lieu d’être recopiée dans chaque Form.
fn raw_inherited(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    for _ in 0..32 {
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        current = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn matrix_from_object(doc: &Document, object: &Object) -> Option<Matrix> {
    let items = doc.dereference(object).ok()?.1.as_array().ok()?;
    if items.len() != 6 {
        return None;
    }
    let mut values = [0.0_f64; 6];
    for (slot, item) in values.iter_mut().zip(items) {
        *slot = object_to_f64(doc.dereference(item).ok()?.1)?;
    }
    Some(Matrix {
        a: values[0],
        b: values[1],
        c: values[2],
        d: values[3],
        e: values[4],
        f: values[5],
    })
}

/// Apparence normale de l’annotation (`/AP /N`, état `/AS` le cas échéant).
fn normal_appearance(doc: &Document, annot: &Dictionary) -> Option<ObjectId> {
    let appearances = doc.dereference(annot.get(b"AP").ok()?).ok()?.1.as_dict().ok()?;
    let normal = appearances.get(b"N").ok()?;
    let stream_id = match normal {
        Object::Reference(id) => match doc.get_object(*id).ok()? {
            Object::Stream(_) => *id,
            Object::Dictionary(states) => {
                states.get(annot.get(b"AS").ok()?.as_name().ok()?).ok()?.as_reference().ok()?
            }
            _ => return None,
        },
        Object::Dictionary(states) => {
            states.get(annot.get(b"AS").ok()?.as_name().ok()?).ok()?.as_reference().ok()?
        }
        _ => return None,
    };
    doc.get_object(stream_id).ok()?.as_stream().ok()?;
    Some(stream_id)
}

/// Matrice qui pose l’apparence dans le `/Rect` de l’annotation (PDF 32000,
/// 12.5.5) : la BBox transformée par la `/Matrix` du Form est ramenée au Rect.
fn appearance_matrix(doc: &Document, stream_id: ObjectId, rect: Rect) -> Option<Matrix> {
    let stream = doc.get_object(stream_id).ok()?.as_stream().ok()?;
    let bbox = rect_from_object(doc, stream.dict.get(b"BBox").ok()?)?;
    let form_matrix = match stream.dict.get(b"Matrix") {
        Ok(object) => matrix_from_object(doc, object)?,
        Err(_) => IDENTITY,
    };
    let corners = [
        form_matrix.apply(bbox.x0, bbox.y0),
        form_matrix.apply(bbox.x1, bbox.y0),
        form_matrix.apply(bbox.x1, bbox.y1),
        form_matrix.apply(bbox.x0, bbox.y1),
    ];
    let x0 = corners.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    let x1 = corners.iter().map(|c| c.0).fold(f64::NEG_INFINITY, f64::max);
    let y0 = corners.iter().map(|c| c.1).fold(f64::INFINITY, f64::min);
    let y1 = corners.iter().map(|c| c.1).fold(f64::NEG_INFINITY, f64::max);
    if x1 - x0 <= 0.01 || y1 - y0 <= 0.01 {
        return None;
    }
    let sx = rect.width() / (x1 - x0);
    let sy = rect.height() / (y1 - y0);
    Some(Matrix {
        a: sx,
        b: 0.0,
        c: 0.0,
        d: sy,
        e: rect.x0 - sx * x0,
        f: rect.y0 - sy * y0,
    })
}

struct AnnotationDraw {
    name: String,
    stream_id: ObjectId,
    matrix: Matrix,
}

/// Annotations à imprimer : drapeau Print levé, Hidden baissé (PDF 32000, 12.5.3).
/// Une page dessinée en Form XObject perd ses annotations : on dessine donc
/// leur apparence, comme le ferait le lecteur au moment d’imprimer.
fn printable_annotations(doc: &Document, page_id: ObjectId, page_index: usize) -> Vec<AnnotationDraw> {
    let Some(annots) = doc
        .get_dictionary(page_id)
        .ok()
        .and_then(|page| page.get(b"Annots").ok())
        .and_then(|annots| doc.dereference(annots).ok())
        .and_then(|(_, object)| object.as_array().ok())
    else {
        return Vec::new();
    };
    annots
        .iter()
        .enumerate()
        .filter_map(|(slot, item)| {
            let annot = doc.dereference(item).ok()?.1.as_dict().ok()?;
            let flags = annot.get(b"F").ok().and_then(|f| f.as_i64().ok()).unwrap_or(0);
            if flags & 4 == 0 || flags & 2 != 0 {
                return None;
            }
            let rect = rect_from_object(doc, annot.get(b"Rect").ok()?)?;
            let stream_id = normal_appearance(doc, annot)?;
            let matrix = appearance_matrix(doc, stream_id, rect)?;
            Some(AnnotationDraw {
                name: format!("SlateAnnot{page_index}_{slot}"),
                stream_id,
                matrix,
            })
        })
        .collect()
}

struct PageForm {
    name: String,
    form_id: ObjectId,
    visible: Rect,
    annotations: Vec<AnnotationDraw>,
}

fn build_page_form(doc: &mut Document, index: usize, page: &SourcePage) -> PageForm {
    let resources = raw_inherited(doc, page.id, b"Resources")
        .unwrap_or_else(|| Object::Dictionary(Dictionary::new()));
    let group = doc
        .get_dictionary(page.id)
        .ok()
        .and_then(|dict| dict.get(b"Group").ok().cloned());
    let annotations = printable_annotations(doc, page.id, index);
    let content = doc.get_page_content(page.id);

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set("FormType", Object::Integer(1));
    dict.set("BBox", rect_to_object(page.visible));
    dict.set("Resources", resources);
    if let Some(group) = group {
        dict.set("Group", group);
    }
    let form_id = doc.add_object(Stream::new(dict, content));
    PageForm {
        name: format!("SlatePage{index}"),
        form_id,
        visible: page.visible,
        annotations,
    }
}

fn rect_to_object(rect: Rect) -> Object {
    Object::Array(vec![
        Object::Real(rect.x0 as f32),
        Object::Real(rect.y0 as f32),
        Object::Real(rect.x1 as f32),
        Object::Real(rect.y1 as f32),
    ])
}

fn pages_root(doc: &Document) -> Result<ObjectId, String> {
    doc.catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Pages").ok())
        .and_then(|pages| pages.as_reference().ok())
        .ok_or_else(|| "Arbre de pages introuvable dans le PDF.".to_string())
}

fn sheet_page(doc: &mut Document, root: ObjectId, size: (f64, f64), resources: Dictionary, content: Vec<u8>) -> ObjectId {
    let content_id = doc.add_object(Stream::new(Dictionary::new(), content));
    let mut page = Dictionary::new();
    page.set("Type", Object::Name(b"Page".to_vec()));
    page.set("Parent", Object::Reference(root));
    page.set("MediaBox", rect_to_object(Rect::new(0.0, 0.0, size.0, size.1)));
    page.set("Resources", Object::Dictionary(resources));
    page.set("Contents", Object::Reference(content_id));
    doc.add_object(page)
}

fn write_sheets(
    doc: &mut Document,
    root: ObjectId,
    sources: &[SourcePage],
    specs: Vec<SheetSpec>,
    sheet: (f64, f64),
) -> Vec<ObjectId> {
    let mut forms: HashMap<usize, PageForm> = HashMap::new();
    let mut font_id: Option<ObjectId> = None;
    let mut sheet_ids = Vec::with_capacity(specs.len());
    for spec in specs {
        let mut content = String::new();
        let mut xobjects = Dictionary::new();
        for item in &spec.items {
            let form = &*forms
                .entry(item.source)
                .or_insert_with(|| build_page_form(doc, item.source, &sources[item.source]));
            let visible = form.visible;
            xobjects.set(form.name.as_bytes().to_vec(), Object::Reference(form.form_id));
            // Le clip sur la zone visible empêche une page tournée ou agrandie
            // de déborder sur sa voisine.
            content.push_str(&format!(
                "q\n{}\n{:.4} {:.4} {:.4} {:.4} re W n\n/{} Do\n",
                item.matrix.to_cm(),
                visible.x0,
                visible.y0,
                visible.width(),
                visible.height(),
                form.name
            ));
            for annotation in &form.annotations {
                xobjects.set(
                    annotation.name.as_bytes().to_vec(),
                    Object::Reference(annotation.stream_id),
                );
                content.push_str(&format!(
                    "q\n{}\n/{} Do\nQ\n",
                    annotation.matrix.to_cm(),
                    annotation.name
                ));
            }
            content.push_str("Q\n");
            if item.border {
                let corners = [
                    item.matrix.apply(visible.x0, visible.y0),
                    item.matrix.apply(visible.x1, visible.y0),
                    item.matrix.apply(visible.x1, visible.y1),
                    item.matrix.apply(visible.x0, visible.y1),
                ];
                content.push_str(&format!(
                    "q 0 G {BORDER_WIDTH_PT} w {:.3} {:.3} m {:.3} {:.3} l {:.3} {:.3} l {:.3} {:.3} l h S Q\n",
                    corners[0].0, corners[0].1, corners[1].0, corners[1].1,
                    corners[2].0, corners[2].1, corners[3].0, corners[3].1
                ));
            }
        }
        content.push_str(&spec.overlay);

        let mut resources = Dictionary::new();
        if !xobjects.is_empty() {
            resources.set("XObject", Object::Dictionary(xobjects));
        }
        if spec.needs_font {
            let id = *font_id.get_or_insert_with(|| {
                let mut font = Dictionary::new();
                font.set("Type", Object::Name(b"Font".to_vec()));
                font.set("Subtype", Object::Name(b"Type1".to_vec()));
                font.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
                doc.add_object(font)
            });
            let mut fonts = Dictionary::new();
            fonts.set("SlateLabel", Object::Reference(id));
            resources.set("Font", Object::Dictionary(fonts));
        }
        sheet_ids.push(sheet_page(doc, root, sheet, resources, content.into_bytes()));
    }
    sheet_ids
}

/// Ordre final des faces. En recto verso, l’inversion porte sur les feuilles :
/// chaque paire recto/verso reste dans le bon sens, complétée d’une face
/// blanche si le compte est impair.
fn output_order<T: Copy>(
    mut sheets: Vec<T>,
    reverse: bool,
    two_sided: bool,
    blank: impl FnOnce() -> T,
) -> Vec<T> {
    if !reverse {
        return sheets;
    }
    if !two_sided {
        sheets.reverse();
        return sheets;
    }
    if sheets.len() % 2 == 1 {
        sheets.push(blank());
    }
    sheets.chunks(2).rev().flatten().copied().collect()
}

/// Rattache `pages`, dans cet ordre, directement à la racine de l’arbre.
fn install_pages(doc: &mut Document, root: ObjectId, pages: &[ObjectId]) -> Result<(), String> {
    for page_id in pages {
        // Rattachée à la racine, la page perdrait ce qu’elle héritait de ses
        // nœuds intermédiaires : on le recopie sur elle d’abord.
        let own = doc
            .get_dictionary(*page_id)
            .map_err(|e| format!("Page illisible dans le PDF : {e}"))?;
        let missing: Vec<&[u8]> = INHERITABLE_KEYS
            .into_iter()
            .filter(|key| !own.has(key))
            .collect();
        let inherited: Vec<(&[u8], Object)> = missing
            .into_iter()
            .filter_map(|key| raw_inherited(doc, *page_id, key).map(|value| (key, value)))
            .collect();
        if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(*page_id) {
            for (key, value) in inherited {
                dict.set(key.to_vec(), value);
            }
            dict.set("Parent", Object::Reference(root));
        }
    }
    let Ok(Object::Dictionary(root_dict)) = doc.get_object_mut(root) else {
        return Err("Racine de l’arbre de pages illisible.".into());
    };
    root_dict.set(
        "Kids",
        Object::Array(pages.iter().map(|id| Object::Reference(*id)).collect()),
    );
    root_dict.set("Count", Object::Integer(pages.len() as i64));
    clear_page_tree_attributes(doc);
    Ok(())
}

fn save(doc: &mut Document) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    doc.save_to(&mut std::io::Cursor::new(&mut out))
        .map_err(|e| format!("Enregistrement du PDF d’impression impossible : {e}"))?;
    Ok(out)
}

/// Compose les feuilles à imprimer. Le PDF d’entrée n’est pas modifié.
pub fn compose(bytes: &[u8], request: &ComposeRequest) -> Result<Composition, String> {
    let sheet = (request.sheet_width_pts, request.sheet_height_pts);
    if !(sheet.0 > 1.0 && sheet.1 > 1.0 && sheet.0.is_finite() && sheet.1.is_finite()) {
        return Err("Dimensions de papier invalides pour l’imposition.".into());
    }
    let mut doc = alto_pdf_engine::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let sources: Vec<SourcePage> = selected_pages(&doc, &request.selection)?
        .into_iter()
        .map(|(number, id)| SourcePage {
            number,
            id,
            visible: visible_box(&doc, id),
            rotate: page_rotation(&doc, id),
        })
        .collect();

    let mut poster = None;
    let specs = match request.layout {
        Layout::Single { mode, orientation } => layout_single(&sources, sheet, mode, orientation),
        Layout::Multiple {
            grid,
            order,
            borders,
            auto_rotate,
            orientation,
        } => layout_multiple(&sources, sheet, grid, order, borders, auto_rotate, orientation),
        Layout::Booklet { subset, binding } => layout_booklet(&sources, sheet, subset, binding),
        Layout::Poster {
            scale_pct,
            overlap_pt,
            cut_marks,
            labels,
            orientation,
        } => {
            let settings = PosterSettings {
                scale_pct,
                overlap_pt,
                cut_marks,
                labels,
                orientation,
            };
            let (specs, grid) = layout_poster(&sources, sheet, &settings)?;
            poster = Some(grid);
            specs
        }
    };

    let root = pages_root(&doc)?;
    let turned: Vec<bool> = specs.iter().map(|spec| spec.turned).collect();
    let sheets = write_sheets(&mut doc, root, &sources, specs, sheet);
    let count = sheets.len();
    let ordered = output_order(
        sheets.into_iter().zip(turned).collect(),
        request.reverse,
        request.two_sided,
        || (sheet_page(&mut doc, root, sheet, Dictionary::new(), Vec::new()), false),
    );
    let (pages, turned): (Vec<ObjectId>, Vec<bool>) = ordered.into_iter().unzip();
    install_pages(&mut doc, root, &pages)?;
    Ok(Composition {
        bytes: save(&mut doc)?,
        sheets: count,
        poster_grid: poster,
        turned,
    })
}

/// Ne garde que les pages sélectionnées, dans l’ordre du document.
pub fn select_pages(bytes: &[u8], selection: &PageSelection) -> Result<Vec<u8>, String> {
    let mut doc = alto_pdf_engine::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages: Vec<ObjectId> = selected_pages(&doc, selection)?
        .into_iter()
        .map(|(_, id)| id)
        .collect();
    let root = pages_root(&doc)?;
    install_pages(&mut doc, root, &pages)?;
    save(&mut doc)
}

/// Inverse l’ordre des faces d’un PDF déjà à la taille du papier.
pub fn reverse_sheets(bytes: &[u8], two_sided: bool) -> Result<Vec<u8>, String> {
    let mut doc = alto_pdf_engine::load_document(bytes).map_err(|e| format!("lopdf: {e}"))?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let Some(last) = pages.last().copied() else {
        return Err("Le PDF ne contient aucune page.".into());
    };
    let media = page_media_box(&doc, last);
    let root = pages_root(&doc)?;
    let ordered = output_order(pages, true, two_sided, || {
        sheet_page(&mut doc, root, (media.width(), media.height()), Dictionary::new(), Vec::new())
    });
    install_pages(&mut doc, root, &ordered)?;
    save(&mut doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A4: (f64, f64) = (595.28, 841.89);

    fn approx(left: f64, right: f64) {
        assert!((left - right).abs() < 0.01, "attendu {right}, obtenu {left}");
    }

    fn source(number: u32, width: f64, height: f64) -> SourcePage {
        SourcePage {
            number,
            id: (number, 0),
            visible: Rect::new(0.0, 0.0, width, height),
            rotate: 0,
        }
    }

    fn a4_pages(count: u32) -> Vec<SourcePage> {
        (1..=count).map(|n| source(n, A4.0, A4.1)).collect()
    }

    /// PDF de `count` pages A4, chacune avec un rectangle ; la page 1 porte
    /// une annotation imprimable et une autre masquée.
    fn sample_pdf(count: usize) -> Vec<u8> {
        let mut objects: Vec<String> = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".into(),
            String::new(),
        ];
        let mut kids = Vec::new();
        for index in 0..count {
            let page_id = objects.len() + 1;
            let content_id = page_id + 1;
            kids.push(format!("{page_id} 0 R"));
            let annots = if index == 0 { " /Annots [100 0 R 101 0 R]" } else { "" };
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents {content_id} 0 R{annots} >>"
            ));
            let content = format!("0 0 1 rg 10 10 {} 100 re f", 100 + index);
            objects.push(format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ));
        }
        objects[1] = format!("<< /Type /Pages /Count {count} /Kids [{}] >>", kids.join(" "));
        let appearance = "1 0 0 rg 0 0 20 20 re f";
        let mut extra = vec![
            (100, "<< /Type /Annot /Subtype /Square /Rect [50 50 90 90] /F 4 /AP << /N 102 0 R >> >>".to_string()),
            (101, "<< /Type /Annot /Subtype /Square /Rect [50 50 90 90] /F 6 /AP << /N 102 0 R >> >>".to_string()),
            (102, format!(
                "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length {} >>\nstream\n{appearance}\nendstream",
                appearance.len()
            )),
        ];
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push((index + 1, out.len()));
            out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", index + 1).as_bytes());
        }
        for (id, body) in extra.drain(..) {
            offsets.push((id, out.len()));
            out.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        let size = 103;
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
        for id in 1..size {
            match offsets.iter().find(|(object, _)| *object == id) {
                Some((_, offset)) => out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes()),
                None => out.extend_from_slice(b"0000000000 65535 f \n"),
            }
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        out
    }

    fn request(layout: Layout) -> ComposeRequest<'static> {
        ComposeRequest {
            sheet_width_pts: A4.0,
            sheet_height_pts: A4.1,
            selection: PageSelection {
                range: None,
                parity: Parity::All,
            },
            layout,
            reverse: false,
            two_sided: false,
        }
    }

    fn page_contents(bytes: &[u8]) -> Vec<String> {
        let doc = alto_pdf_engine::load_document(bytes).expect("relecture");
        doc.get_pages()
            .values()
            .map(|id| String::from_utf8_lossy(&doc.get_page_content(*id)).to_string())
            .collect()
    }

    #[test]
    fn page_range_accepts_cups_syntax() {
        let pages = parse_page_range("1-3, 5", 10).expect("plage");
        assert_eq!(pages.into_iter().collect::<Vec<_>>(), vec![1, 2, 3, 5]);
        let open = parse_page_range("8-", 10).expect("plage ouverte");
        assert_eq!(open.into_iter().collect::<Vec<_>>(), vec![8, 9, 10]);
        let head = parse_page_range("-2", 10).expect("début");
        assert_eq!(head.into_iter().collect::<Vec<_>>(), vec![1, 2]);
        for bad in ["0", "3-1", "a", "1-b"] {
            assert!(parse_page_range(bad, 10).is_err(), "{bad} accepté");
        }
    }

    #[test]
    fn two_up_puts_portrait_pages_side_by_side_on_a_turned_sheet() {
        let specs = layout_multiple(
            &a4_pages(3),
            A4,
            Grid::Preset(2),
            PageOrder::Horizontal,
            false,
            true,
            Orientation::Auto,
        );
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].items.len(), 2);
        assert_eq!(specs[1].items.len(), 1);
        assert!(specs.iter().all(|spec| spec.turned));
        // A4 sur une demi-A4 couchée : 1/√2, pas 1/2.
        let matrix = specs[0].items[0].matrix;
        approx(
            (matrix.a * matrix.a + matrix.b * matrix.b).sqrt(),
            std::f64::consts::FRAC_1_SQRT_2,
        );
        // Toutes les pages restent sur la feuille.
        for item in specs.iter().flat_map(|s| &s.items) {
            for (x, y) in [(0.0, 0.0), (A4.0, 0.0), (A4.0, A4.1), (0.0, A4.1)] {
                let (tx, ty) = item.matrix.apply(x, y);
                assert!(
                    (-0.01..=A4.0 + 0.01).contains(&tx) && (-0.01..=A4.1 + 0.01).contains(&ty),
                    "coin hors feuille : ({tx}, {ty})"
                );
            }
        }
    }

    #[test]
    fn four_up_horizontal_order_reads_left_to_right_then_down() {
        let specs = layout_multiple(
            &a4_pages(4),
            A4,
            Grid::Preset(4),
            PageOrder::Horizontal,
            false,
            true,
            Orientation::Portrait,
        );
        let origins: Vec<(f64, f64)> = specs[0]
            .items
            .iter()
            .map(|item| item.matrix.apply(0.0, 0.0))
            .collect();
        // Page 1 en haut à gauche, page 2 à sa droite, page 3 dessous.
        assert!(origins[1].0 > origins[0].0 && (origins[1].1 - origins[0].1).abs() < 0.01);
        assert!(origins[2].1 < origins[0].1 && (origins[2].0 - origins[0].0).abs() < 0.01);
        let vertical = layout_multiple(
            &a4_pages(4),
            A4,
            Grid::Preset(4),
            PageOrder::Vertical,
            false,
            true,
            Orientation::Portrait,
        );
        let second = vertical[0].items[1].matrix.apply(0.0, 0.0);
        assert!(second.1 < origins[0].1 && (second.0 - origins[0].0).abs() < 0.01);
    }

    #[test]
    fn six_up_prefers_upright_pages_on_a_turned_sheet() {
        let specs = layout_multiple(
            &a4_pages(6),
            A4,
            Grid::Preset(6),
            PageOrder::Horizontal,
            false,
            true,
            Orientation::Auto,
        );
        // Feuille couchée, 3 × 2, pages droites : seul le quart de tour de la
        // feuille apparaît dans la matrice (a = 0, b = -s).
        let matrix = specs[0].items[0].matrix;
        assert!(matrix.a.abs() < 1e-9 && matrix.b < 0.0, "{matrix:?}");
    }

    #[test]
    fn booklet_imposes_pages_in_folding_order() {
        assert_eq!(
            booklet_sides(5, BookletSubset::Both, Binding::Left),
            vec![(7, 0), (1, 6), (5, 2), (3, 4)]
        );
        assert_eq!(
            booklet_sides(4, BookletSubset::Both, Binding::Right),
            vec![(0, 3), (2, 1)]
        );
        assert_eq!(booklet_sides(8, BookletSubset::Front, Binding::Left), vec![(7, 0), (5, 2)]);
        let specs = layout_booklet(&a4_pages(5), A4, BookletSubset::Both, Binding::Left);
        assert_eq!(specs.len(), 4);
        // Couverture : seule la page 1, à droite ; la page 8 n’existe pas.
        assert_eq!(specs[0].items.len(), 1);
        assert_eq!(specs[0].items[0].source, 0);
    }

    #[test]
    fn poster_tiles_a4_at_200_percent_on_four_sheets() {
        let settings = PosterSettings {
            scale_pct: 200.0,
            overlap_pt: 0.0,
            cut_marks: true,
            labels: true,
            orientation: Orientation::Auto,
        };
        let (specs, grid) = layout_poster(&a4_pages(1), A4, &settings).expect("affiche");
        assert_eq!(grid, (2, 2));
        assert_eq!(specs.len(), 4);
        // Feuille A1 : le coin haut gauche de la page arrive en haut à gauche.
        let (x, y) = specs[0].items[0].matrix.apply(0.0, A4.1);
        approx(x, 0.0);
        approx(y, A4.1);
        assert!(specs[3].overlay.contains("(1 / B2) Tj"));
    }

    #[test]
    fn poster_overlap_adds_tiles_and_cut_marks() {
        let settings = PosterSettings {
            scale_pct: 200.0,
            overlap_pt: 10.0 * MM_TO_PT,
            cut_marks: true,
            labels: false,
            orientation: Orientation::Portrait,
        };
        let (specs, grid) = layout_poster(&a4_pages(1), A4, &settings).expect("affiche");
        assert_eq!(grid, (3, 3));
        assert_eq!(specs.len(), 9);
        assert!(specs[0].overlay.is_empty(), "première feuille sans voisine");
        assert!(specs[4].overlay.contains(" l S"));
        let huge = PosterSettings {
            overlap_pt: A4.0,
            ..settings
        };
        assert!(layout_poster(&a4_pages(1), A4, &huge).is_err());
    }

    #[test]
    fn reverse_keeps_duplex_pairs_together() {
        let ids: Vec<ObjectId> = (1..=3).map(|n| (n, 0)).collect();
        assert_eq!(
            output_order(ids.clone(), true, false, || (99, 0)),
            vec![(3, 0), (2, 0), (1, 0)]
        );
        assert_eq!(
            output_order(ids.clone(), true, true, || (99, 0)),
            vec![(3, 0), (99, 0), (1, 0), (2, 0)]
        );
        assert_eq!(output_order(ids.clone(), false, true, || (99, 0)), ids);
    }

    #[test]
    fn compose_single_selects_odd_pages_and_keeps_printable_annotations() {
        let mut odd = request(Layout::Single {
            mode: ScaleMode::Fit,
            orientation: Orientation::Auto,
        });
        odd.selection.parity = Parity::Odd;
        let composition = compose(&sample_pdf(5), &odd).expect("composition");
        assert_eq!(composition.sheets, 3);
        let doc = alto_pdf_engine::load_document(&composition.bytes).expect("relecture");
        for id in doc.get_pages().values() {
            let media = page_media_box(&doc, *id);
            approx(media.width(), A4.0);
            approx(media.height(), A4.1);
        }
        let contents = page_contents(&composition.bytes);
        // Annotation imprimable dessinée une fois ; la masquée, jamais.
        assert_eq!(contents[0].matches("/SlateAnnot0_0 Do").count(), 1);
        assert!(!contents[0].contains("SlateAnnot0_1"));
    }

    #[test]
    fn compose_absorbs_page_rotation_and_rejects_absurd_sheet() {
        let mut doc = alto_pdf_engine::load_document(&sample_pdf(1)).expect("lecture");
        let page_id = *doc.get_pages().values().next().expect("une page");
        if let Ok(Object::Dictionary(page)) = doc.get_object_mut(page_id) {
            page.set("MediaBox", rect_to_object(Rect::new(0.0, 0.0, 432.0, 288.0)));
            page.set("Rotate", Object::Integer(90));
        }
        let rotated = save(&mut doc).expect("écriture");

        let mut label = request(Layout::Single {
            mode: ScaleMode::Fit,
            orientation: Orientation::Auto,
        });
        label.sheet_width_pts = 288.0;
        label.sheet_height_pts = 432.0;
        let composition = compose(&rotated, &label).expect("composition");
        let out = alto_pdf_engine::load_document(&composition.bytes).expect("relecture");
        let sheet_id = *out.get_pages().values().next().expect("une feuille");
        let media = page_media_box(&out, sheet_id);
        approx(media.width(), 288.0);
        approx(media.height(), 432.0);
        assert_eq!(page_rotation(&out, sheet_id), 0);
        let content = String::from_utf8_lossy(&out.get_page_content(sheet_id)).to_string();
        // Rotation 90 absorbée, échelle 1 : matrice 0 -1 1 0.
        assert!(content.contains("0.00000 -1.00000 1.00000 0.00000"), "{content}");

        label.sheet_width_pts = 0.0;
        assert!(compose(&rotated, &label).is_err());
    }

    #[test]
    fn compose_booklet_and_poster_produce_expected_sheet_counts() {
        let booklet = compose(
            &sample_pdf(5),
            &request(Layout::Booklet {
                subset: BookletSubset::Both,
                binding: Binding::Left,
            }),
        )
        .expect("livret");
        assert_eq!(booklet.sheets, 4);
        assert_eq!(page_contents(&booklet.bytes).len(), 4);
        assert_eq!(booklet.turned, vec![true; 4]);

        let poster = compose(
            &sample_pdf(1),
            &request(Layout::Poster {
                scale_pct: 200.0,
                overlap_pt: 0.0,
                cut_marks: false,
                labels: true,
                orientation: Orientation::Auto,
            }),
        )
        .expect("affiche");
        assert_eq!(poster.poster_grid, Some((2, 2)));
        assert_eq!(page_contents(&poster.bytes).len(), 4);
        assert_eq!(poster.turned, vec![false; 4]);
    }

    #[test]
    fn select_then_reverse_keeps_page_content() {
        let selection = PageSelection {
            range: Some("2-4"),
            parity: Parity::All,
        };
        let selected = select_pages(&sample_pdf(5), &selection).expect("sélection");
        let reversed = reverse_sheets(&selected, false).expect("inversion");
        let contents = page_contents(&reversed);
        assert_eq!(contents.len(), 3);
        // Page 4 d’origine en premier (rectangle de 103 de large).
        assert!(contents[0].contains("103 100 re"), "{}", contents[0]);
        assert!(contents[2].contains("101 100 re"), "{}", contents[2]);
    }

    #[test]
    fn invalid_layouts_are_rejected() {
        let mode = ScaleMode::Fit;
        let orientation = Orientation::Auto;
        let bad = [
            LayoutOptions { kind: "multiple".into(), pages_per_sheet: 3, ..Default::default() },
            LayoutOptions { kind: "multiple".into(), pages_per_sheet: 0, columns: 11, rows: 1, ..Default::default() },
            LayoutOptions { kind: "poster".into(), tile_scale: 0.0, ..Default::default() },
            LayoutOptions { kind: "poster".into(), tile_scale: 100.0, overlap_mm: 80.0, ..Default::default() },
            LayoutOptions { kind: "booklet".into(), booklet_binding: "top".into(), ..Default::default() },
            LayoutOptions { kind: "spiral".into(), ..Default::default() },
        ];
        for options in bad {
            assert!(options.resolve(mode, orientation).is_err(), "{options:?} accepté");
        }
        let booklet = LayoutOptions { kind: "booklet".into(), ..Default::default() }
            .resolve(mode, orientation)
            .expect("livret");
        assert_eq!(booklet.forced_sides(), Some("two-sided-short-edge"));
    }
}
