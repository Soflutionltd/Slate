//! Génération d'un PDF depuis une source Typst (outils MCP `create_document`
//! et `pdf_create`). L'IA écrit le document, le moteur le met en page.
//!
//! Monde fermé : pas de réseau, pas de paquets, pas de lecture disque. Les
//! seuls fichiers visibles sont la source et les images passées par l'appelant.
//! Polices : Liberation (embarquées, compatibles Arial/Times/Courier) puis
//! celles du système.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::{Datelike, Duration as ChronoDuration, Local, Utc};
use typst::diag::{FileError, FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration, Smart};
use typst_layout::PagedDocument;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_kit::fonts::FontStore;

use crate::pdf_fallback_font::embedded_font_files;

pub const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_IMAGES: usize = 50;
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
const MAX_REPORTED_ERRORS: usize = 10;

/// Réglage par défaut, sur UNE ligne : Typst compte les lignes à partir de 0,
/// l'index d'une ligne est donc son numéro dans la source de l'appelant.
const PREAMBLE: &str = "#set text(font: \"Liberation Sans\")\n";

/// Image nommée, référencée dans la source par `image("nom.png")`.
pub struct GenerateImage {
    pub name: String,
    pub bytes: Vec<u8>,
}

pub struct GeneratedPdf {
    pub bytes: Vec<u8>,
    pub pages: usize,
    pub warnings: Vec<String>,
}

pub fn has_image_extension(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Nom d'image accepté : lettres, chiffres, `.`, `_`, `-`, extension d'image.
pub fn validate_image_name(name: &str) -> Result<(), String> {
    let valid_chars = !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    match valid_chars && has_image_extension(name) {
        true => Ok(()),
        false => Err(format!(
            "invalid image name \"{name}\": use letters, digits, dot, dash or underscore, ending in .png, .jpg, .jpeg, .gif, .svg or .webp"
        )),
    }
}

fn library() -> &'static LazyHash<Library> {
    static LIBRARY: OnceLock<LazyHash<Library>> = OnceLock::new();
    LIBRARY.get_or_init(|| LazyHash::new(Library::builder().build()))
}

fn fonts() -> &'static FontStore {
    static FONTS: OnceLock<FontStore> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut store = FontStore::new();
        for data in embedded_font_files() {
            store.extend(Font::iter(Bytes::new(data)).map(|font| {
                let info = font.info().clone();
                (font, info)
            }));
        }
        store.extend(typst_kit::fonts::system());
        store
    })
}

fn file_id(path: &str) -> Result<FileId, String> {
    let vpath = VirtualPath::new(path).map_err(|e| format!("invalid path {path}: {e:?}"))?;
    Ok(RootedPath::new(VirtualRoot::Project, vpath).intern())
}

struct DocumentWorld {
    main: Source,
    files: HashMap<FileId, Bytes>,
}

impl World for DocumentWorld {
    fn library(&self) -> &LazyHash<Library> {
        library()
    }

    fn book(&self) -> &LazyHash<FontBook> {
        fonts().book()
    }

    fn main(&self) -> FileId {
        self.main.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() {
            Ok(self.main.clone())
        } else if self.files.contains_key(&id) {
            Err(FileError::NotSource)
        } else {
            Err(FileError::NotFound(PathBuf::from(format!("{id:?}"))))
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main.id() {
            return Ok(Bytes::from_string(self.main.clone()));
        }
        self.files.get(&id).cloned().ok_or_else(|| {
            FileError::Other(Some(
                format!("{id:?} is not available: pass it in images (only those files can be used)").into(),
            ))
        })
    }

    fn font(&self, index: usize) -> Option<Font> {
        fonts().font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let date = match offset {
            None => Local::now().date_naive(),
            Some(offset) => {
                let shift = ChronoDuration::try_seconds(offset.seconds() as i64)?;
                (Utc::now() + shift).date_naive()
            }
        };
        Datetime::from_ymd(date.year(), date.month() as u8, date.day() as u8)
    }
}

impl DocumentWorld {
    fn describe(&self, diagnostic: &SourceDiagnostic) -> String {
        let location = diagnostic
            .span
            .id()
            .filter(|id| *id == self.main.id())
            .and_then(|_| self.range(diagnostic.span))
            .and_then(|range| self.main.lines().byte_to_line_column(range.start))
            .filter(|(line, _)| *line >= 1)
            .map(|(line, column)| format!("line {line}, column {}: ", column + 1))
            .unwrap_or_default();
        let mut text = format!("{location}{}", diagnostic.message);
        for hint in &diagnostic.hints {
            text.push_str(&format!(" (hint: {})", hint.v));
        }
        text
    }
}

/// Compile la source Typst en PDF. Erreur : liste lisible par l'IA (ligne,
/// colonne, message, indices) pour qu'elle corrige sa source et réessaie.
pub fn generate_pdf(source: &str, images: Vec<GenerateImage>) -> Result<GeneratedPdf, String> {
    if source.trim().is_empty() {
        return Err("source is empty".to_string());
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(format!("source is larger than {} MB", MAX_SOURCE_BYTES / 1024 / 1024));
    }
    if images.len() > MAX_IMAGES {
        return Err(format!("at most {MAX_IMAGES} images"));
    }
    let mut files = HashMap::new();
    for image in images {
        validate_image_name(&image.name)?;
        if image.bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!("image {} is larger than {} MB", image.name, MAX_IMAGE_BYTES / 1024 / 1024));
        }
        if files.insert(file_id(&format!("/{}", image.name))?, Bytes::new(image.bytes)).is_some() {
            return Err(format!("image {} is given twice", image.name));
        }
    }
    let world = DocumentWorld {
        main: Source::new(file_id("/main.typ")?, format!("{PREAMBLE}{source}")),
        files,
    };
    catch_unwind(AssertUnwindSafe(|| compile(&world)))
        .map_err(|_| "the document engine crashed on this source; simplify it and try again".to_string())?
}

fn compile(world: &DocumentWorld) -> Result<GeneratedPdf, String> {
    let warned = typst::compile::<PagedDocument>(world);
    let warnings: Vec<String> = warned.warnings.iter().map(|w| world.describe(w)).collect();
    let document = warned.output.map_err(|errors| report(world, &errors))?;
    // Identifiant PDF tiré du contenu : Typst le dérive sinon du titre et de
    // l'auteur, et deux documents différents de même titre partageraient
    // l'empreinte qui sert à Slate à reconnaître un document déjà ouvert.
    let options = typst_pdf::PdfOptions {
        ident: Smart::Custom(content_ident(world)),
        creator: Smart::Custom(Some("Slate".to_string())),
        ..Default::default()
    };
    let bytes = typst_pdf::pdf(&document, &options).map_err(|errors| report(world, &errors))?;
    Ok(GeneratedPdf { pages: document.pages().len(), bytes, warnings })
}

fn content_ident(world: &DocumentWorld) -> String {
    let mut hasher = DefaultHasher::new();
    world.main.text().hash(&mut hasher);
    let mut files: Vec<_> = world.files.iter().map(|(id, bytes)| (format!("{id:?}"), bytes.as_slice())).collect();
    files.sort();
    files.hash(&mut hasher);
    format!("slate-generated-{:016x}", hasher.finish())
}

fn report(world: &DocumentWorld, errors: &[SourceDiagnostic]) -> String {
    let mut lines: Vec<String> =
        errors.iter().take(MAX_REPORTED_ERRORS).map(|e| world.describe(e)).collect();
    if errors.len() > MAX_REPORTED_ERRORS {
        lines.push(format!("… and {} more errors", errors.len() - MAX_REPORTED_ERRORS));
    }
    format!("the document has errors:\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUOTE: &str = r#"#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt, lang: "fr")
= Devis n° 2026-014
Client : SASU Exemple

#table(
  columns: (1fr, auto, auto),
  [*Prestation*], [*Quantité*], [*Prix HT*],
  [Site vitrine], [1], [2 400 €],
  [Maintenance mensuelle], [12], [90 €],
)

Total HT : *3 480 €*
"#;

    #[test]
    fn quote_compiles_to_a_readable_pdf() {
        let generated = generate_pdf(QUOTE, Vec::new()).expect("quote compiles");
        assert!(generated.bytes.starts_with(b"%PDF-"));
        assert_eq!(generated.pages, 1);
        let doc = crate::load_document(&generated.bytes).expect("lopdf reads it");
        let text = doc.extract_text(&[1]).expect("text extractable");
        assert!(text.contains("Devis"), "{text}");
        assert!(text.contains("Maintenance"), "{text}");
    }

    #[test]
    fn same_title_different_content_gets_a_different_pdf_id() {
        let pdf_id = |source: &str| {
            let bytes = generate_pdf(source, Vec::new()).expect("compiles").bytes;
            let doc = crate::load_document(&bytes).expect("lopdf reads it");
            format!("{:?}", doc.trailer.get(b"ID").expect("has /ID"))
        };
        let first = pdf_id("#set document(title: \"Devis\")\nPrix : 100 €");
        let second = pdf_id("#set document(title: \"Devis\")\nPrix : 120 €");
        assert_ne!(first, second);
        assert_eq!(first, pdf_id("#set document(title: \"Devis\")\nPrix : 100 €"));
    }

    #[test]
    fn errors_point_to_the_callers_line() {
        let error = match generate_pdf("Bonjour\n#unknown_function()\n", Vec::new()) {
            Err(error) => error,
            Ok(_) => panic!("unknown function must fail"),
        };
        assert!(error.contains("line 2, column 2"), "{error}");
        assert!(error.contains("unknown variable"), "{error}");
    }

    #[test]
    fn only_given_images_are_readable() {
        let png = {
            let mut out = Vec::new();
            image::RgbImage::from_pixel(4, 4, image::Rgb([200, 30, 30]))
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .expect("png");
            out
        };
        let ok = generate_pdf(
            "#image(\"logo.png\", width: 2cm)",
            vec![GenerateImage { name: "logo.png".into(), bytes: png }],
        );
        assert!(ok.is_ok(), "{:?}", ok.err());
        let error = match generate_pdf("#image(\"/etc/passwd.png\")", Vec::new()) {
            Err(error) => error,
            Ok(_) => panic!("ungiven file must fail"),
        };
        assert!(error.contains("only those files can be used"), "{error}");
    }

    #[test]
    fn image_names_are_restricted() {
        assert!(validate_image_name("logo-2026_v1.PNG").is_ok());
        for bad in ["../x.png", "a/b.png", ".png", "x.exe", "x", ""] {
            assert!(validate_image_name(bad).is_err(), "{bad}");
        }
    }
}
