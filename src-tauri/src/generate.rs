//! Arguments des outils de génération de documents, communs à l'app
//! (`create_document`) et au serveur `alto-mcp` (`pdf_create`).

use std::path::Path;

use base64::Engine as _;
use serde::Deserialize;

pub use alto_pdf_engine::pdf_generate::{generate_pdf, GenerateImage, GeneratedPdf};
use alto_pdf_engine::pdf_generate::{has_image_extension, validate_image_name, MAX_IMAGE_BYTES};

/// Image passée par l'IA : un fichier de l'ordinateur (`path`) ou son
/// contenu en base64 (`data`), sous le nom utilisé dans la source.
#[derive(Debug, Deserialize)]
pub struct ImageArg {
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
}

pub fn load_images(images: Vec<ImageArg>) -> Result<Vec<GenerateImage>, String> {
    images.into_iter().map(load_image).collect()
}

fn load_image(image: ImageArg) -> Result<GenerateImage, String> {
    validate_image_name(&image.name)?;
    let bytes = match (image.path.as_deref(), image.data.as_deref()) {
        (Some(path), None) => read_image_file(path)?,
        (None, Some(data)) => decode_image_data(&image.name, data)?,
        _ => return Err(format!("image {}: give either path or data, not both", image.name)),
    };
    Ok(GenerateImage { name: image.name, bytes })
}

fn read_image_file(path: &str) -> Result<Vec<u8>, String> {
    let file = Path::new(path);
    if !file.is_absolute() {
        return Err(format!("image path must be absolute: {path}"));
    }
    if !has_image_extension(path) {
        return Err(format!("not an image file (png, jpg, jpeg, gif, svg, webp): {path}"));
    }
    let size = std::fs::metadata(file).map_err(|e| format!("cannot read {path}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES as u64 {
        return Err(format!("image larger than {} MB: {path}", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    std::fs::read(file).map_err(|e| format!("cannot read {path}: {e}"))
}

fn decode_image_data(name: &str, data: &str) -> Result<Vec<u8>, String> {
    let encoded = data.split_once(";base64,").map_or(data, |(_, rest)| rest).trim();
    if encoded.len() / 4 * 3 > MAX_IMAGE_BYTES {
        return Err(format!("image {name} is larger than {} MB", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("image {name}: invalid base64 data ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(name: &str, path: Option<&str>, data: Option<&str>) -> ImageArg {
        ImageArg { name: name.into(), path: path.map(Into::into), data: data.map(Into::into) }
    }

    /// Chaque construction citée dans la description de `create_document`
    /// (ai-tools.json) : une IA qui la recopie doit obtenir un PDF, sans alerte.
    #[test]
    fn every_construct_of_the_tool_description_compiles() {
        let source = r##"#set page(paper: "a4", margin: 2cm, footer: context align(center)[#counter(page).display() / #counter(page).final().first()])
#set text(font: "Liberation Sans", size: 11pt, lang: "fr")
#set par(justify: true)
= Devis
== Prestations
*gras*, _italique_
- puce
+ élément numéroté
#align(right)[Calvi, le #datetime.today().display("[day]/[month]/[year]")]
#grid(columns: (1fr, 1fr), gutter: 12pt, [gauche], [droite])
#v(1cm)
Total #h(1fr) 3 480 €
#block(fill: luma(240), inset: 8pt, radius: 4pt, width: 100%)[Encadré]
#line(length: 100%, stroke: 0.5pt + gray)
#table(columns: (1fr, auto, auto), align: (left, right, right), stroke: 0.5pt + gray, inset: 6pt,
  table.header([*Item*], [*Qty*], [*Price*]), [Website], [1], [2 400 €])
#text(fill: rgb("#1a5fb4"), size: 9pt)[petit texte]
#image("logo.svg", width: 4cm)
\# \$ \@ \* \_ \< contact\@example.com \$40
#pagebreak()
#set page(paper: "us-letter")
#set text(font: "Liberation Serif")
Page 2 #text(font: "Liberation Mono")[mono]
"##;
        let logo = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIi8+PC9zdmc+";
        let images = load_images(vec![arg("logo.svg", None, Some(logo))]).expect("svg decodes");
        let generated = generate_pdf(source, images).expect("cheat sheet compiles");
        assert_eq!(generated.pages, 2);
        assert!(generated.warnings.is_empty(), "{:?}", generated.warnings);
    }

    #[test]
    fn base64_with_or_without_data_url_prefix() {
        for data in ["AQID", "data:image/png;base64,AQID"] {
            let images = load_images(vec![arg("a.png", None, Some(data))]).expect("decodes");
            assert_eq!(images[0].bytes, vec![1, 2, 3]);
        }
    }

    #[test]
    fn rejects_relative_non_image_and_ambiguous_sources() {
        assert!(load_images(vec![arg("a.png", Some("logo.png"), None)]).is_err());
        assert!(load_images(vec![arg("a.png", Some("/etc/passwd"), None)]).is_err());
        assert!(load_images(vec![arg("a.png", None, None)]).is_err());
        assert!(load_images(vec![arg("a.png", Some("/x.png"), Some("AQID"))]).is_err());
    }
}
