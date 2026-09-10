use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::encryption::{EncryptionState, EncryptionVersion, Permissions};
use lopdf::{Bookmark, Document, Object, ObjectId, SaveOptions};
use rand::Rng;

fn err_to_string<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn load_doc(bytes: &[u8]) -> Result<Document, String> {
    Document::load_mem(bytes).map_err(err_to_string)
}

fn save_modern(doc: &mut Document) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let options = SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .compression_level(9)
        .build();
    doc.save_with_options(&mut Cursor::new(&mut buf), options)
        .map_err(err_to_string)?;
    Ok(buf)
}

fn save_classic(doc: &mut Document) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    doc.save_to(&mut Cursor::new(&mut buf))
        .map_err(err_to_string)?;
    Ok(buf)
}

/// Merge several PDFs into a single one. Bookmarks for each source are added.
pub fn merge_pdfs(sources: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
    if sources.is_empty() {
        return Err("No PDF provided to merge.".to_string());
    }

    let mut max_id = 1u32;
    let mut pagenum = 1u32;
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut document = Document::with_version("1.5");

    for bytes in sources {
        let mut doc = load_doc(&bytes)?;
        let mut first = false;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        documents_pages.extend(doc.get_pages().into_iter().filter_map(|(_, object_id)| {
            if !first {
                let bookmark = Bookmark::new(
                    format!("Document {}", pagenum),
                    [0.0, 0.0, 0.0],
                    0,
                    object_id,
                );
                document.add_bookmark(bookmark, None);
                first = true;
                pagenum += 1;
            }
            // PDF non fiable : on ignore une page dont l'objet est introuvable
            // plutôt que de paniquer (et faire crasher l'app).
            doc.get_object(object_id)
                .ok()
                .map(|obj| (object_id, obj.to_owned()))
        }));
        documents_objects.extend(doc.objects);
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((
                    if let Some((id, _)) = catalog_object {
                        id
                    } else {
                        *object_id
                    },
                    object.clone(),
                ));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref old_object)) = pages_object {
                        if let Ok(old_dictionary) = old_object.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    pages_object = Some((
                        if let Some((id, _)) = pages_object {
                            id
                        } else {
                            *object_id
                        },
                        Object::Dictionary(dictionary),
                    ));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(*object_id, object.clone());
            }
        }
    }

    let pages_object = pages_object.ok_or_else(|| "Pages root not found.".to_string())?;
    let catalog_object = catalog_object.ok_or_else(|| "Catalog root not found.".to_string())?;

    for (object_id, object) in documents_pages.iter() {
        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_object.0);
            document
                .objects
                .insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    if let Ok(dictionary) = pages_object.1.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .into_iter()
                .map(|(object_id, _)| Object::Reference(object_id))
                .collect::<Vec<_>>(),
        );
        document
            .objects
            .insert(pages_object.0, Object::Dictionary(dictionary));
    }

    if let Ok(dictionary) = catalog_object.1.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", pages_object.0);
        dictionary.remove(b"Outlines");
        document
            .objects
            .insert(catalog_object.0, Object::Dictionary(dictionary));
    }

    document.trailer.set("Root", catalog_object.0);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.adjust_zero_pages();

    if let Some(n) = document.build_outline() {
        if let Ok(Object::Dictionary(dict)) = document.get_object_mut(catalog_object.0) {
            dict.set("Outlines", Object::Reference(n));
        }
    }

    document.compress();
    save_modern(&mut document)
}

/// Encrypt PDF with AES-256 (PDF 2.0 V5 security handler).
pub fn encrypt_pdf(
    bytes: Vec<u8>,
    user_password: String,
    owner_password: Option<String>,
) -> Result<Vec<u8>, String> {
    let mut doc = load_doc(&bytes)?;
    let owner_password = owner_password.unwrap_or_else(|| user_password.clone());

    let crypt_filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let mut file_encryption_key = [0u8; 32];
    rand::rng().fill_bytes(&mut file_encryption_key);

    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), crypt_filter)]),
        file_encryption_key: &file_encryption_key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner_password,
        user_password: &user_password,
        permissions: Permissions::all(),
    };

    let state = EncryptionState::try_from(version).map_err(err_to_string)?;
    doc.encrypt(&state).map_err(err_to_string)?;
    save_classic(&mut doc)
}

/// Aggressive recompression: object streams + xref streams + level 9 + prune unused.
pub fn compress_pdf(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut doc = load_doc(&bytes)?;
    let _ = doc.delete_zero_length_streams();
    let _ = doc.prune_objects();
    doc.compress();
    save_modern(&mut doc)
}

/// Remove every annotation (comments, highlights, links, form-less widgets)
/// from all pages, then recompress. The page content itself is untouched.
pub fn remove_annotations(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut doc = load_doc(&bytes)?;
    let page_ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for page_id in page_ids {
        if let Ok(dict) = doc.get_dictionary_mut(page_id) {
            dict.remove(b"Annots");
        }
    }
    let _ = doc.prune_objects();
    doc.compress();
    save_modern(&mut doc)
}

/// Rotation effective d'une page : `/Rotate` sur la page, sinon hérité des
/// nœuds `/Pages` parents (PDF 32000 §7.7.3.4). La valeur peut être un objet
/// indirect (`5 0 R`) : on la déréférence, sinon un scanner qui écrit ainsi
/// ferait croire à 0° et « 180° » ne produirait qu'un quart de tour.
fn inherited_rotate(doc: &Document, page_id: ObjectId) -> i32 {
    let mut current = Some(page_id);
    for _ in 0..16 {
        let Some(id) = current else { break };
        let Ok(dict) = doc.get_dictionary(id) else { break };
        if let Ok(raw) = dict.get(b"Rotate") {
            let resolved = doc.dereference(raw).map(|(_, obj)| obj).unwrap_or(raw);
            if let Ok(value) = resolved.as_i64() {
                return (value % 360 + 360) as i32 % 360;
            }
        }
        current = dict.get(b"Parent").ok().and_then(|obj| obj.as_reference().ok());
    }
    0
}

/// Rotate the given pages (1-indexed) by `angle` (0/90/180/270) degrees, multiple of 90.
pub fn rotate_pages(bytes: Vec<u8>, page_numbers: Vec<u32>, angle: i32) -> Result<Vec<u8>, String> {
    if angle % 90 != 0 {
        return Err("Rotation angle must be a multiple of 90 degrees.".to_string());
    }
    let mut doc = load_doc(&bytes)?;
    let pages = doc.get_pages();
    let targets: Vec<ObjectId> = if page_numbers.is_empty() {
        pages.values().copied().collect()
    } else {
        page_numbers
            .iter()
            .filter_map(|n| pages.get(n).copied())
            .collect()
    };
    for page_id in targets {
        let current = inherited_rotate(&doc, page_id);
        let new_angle = ((current + angle) % 360 + 360) % 360;
        let dict = doc.get_dictionary_mut(page_id).map_err(err_to_string)?;
        dict.set("Rotate", new_angle as i64);
    }
    save_modern(&mut doc)
}

/// Delete the listed pages (1-indexed).
pub fn delete_pages(bytes: Vec<u8>, page_numbers: Vec<u32>) -> Result<Vec<u8>, String> {
    if page_numbers.is_empty() {
        return Err("No page provided for deletion.".to_string());
    }
    let mut doc = load_doc(&bytes)?;
    doc.delete_pages(&page_numbers);
    doc.adjust_zero_pages();
    let _ = doc.prune_objects();
    save_modern(&mut doc)
}

/// Keep only the listed pages (1-indexed).
pub fn extract_pages(bytes: Vec<u8>, page_numbers: Vec<u32>) -> Result<Vec<u8>, String> {
    if page_numbers.is_empty() {
        return Err("No page provided for extraction.".to_string());
    }
    let mut doc = load_doc(&bytes)?;
    let all_pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    let to_delete: Vec<u32> = all_pages
        .into_iter()
        .filter(|n| !page_numbers.contains(n))
        .collect();
    doc.delete_pages(&to_delete);
    doc.adjust_zero_pages();
    let _ = doc.prune_objects();
    save_modern(&mut doc)
}

/// Return the page count of a PDF buffer without rendering it.
#[allow(dead_code)]
pub fn page_count(bytes: Vec<u8>) -> Result<u32, String> {
    let metadata = Document::load_metadata_mem(&bytes).map_err(err_to_string)?;
    Ok(metadata.page_count as u32)
}

/// Reorder pages according to the provided 1-indexed permutation.
/// The new PDF will contain pages in the order given, dropping any page not listed.
pub fn reorder_pages(bytes: Vec<u8>, new_order: Vec<u32>) -> Result<Vec<u8>, String> {
    if new_order.is_empty() {
        return Err("No page order provided.".to_string());
    }
    let mut doc = load_doc(&bytes)?;
    let pages = doc.get_pages();
    let total = pages.len() as u32;

    for &n in &new_order {
        if n < 1 || n > total {
            return Err(format!(
                "Invalid page number {} in new order (document has {} pages).",
                n, total
            ));
        }
    }

    let pages_root_id = doc
        .catalog()
        .map_err(err_to_string)?
        .get(b"Pages")
        .map_err(err_to_string)?
        .as_reference()
        .map_err(err_to_string)?;

    let new_kids: Vec<Object> = new_order
        .iter()
        .filter_map(|n| pages.get(n).copied().map(Object::Reference))
        .collect();
    let count = new_kids.len() as u32;

    {
        let pages_dict = doc
            .get_dictionary_mut(pages_root_id)
            .map_err(err_to_string)?;
        pages_dict.set("Kids", new_kids);
        pages_dict.set("Count", count as i64);
    }

    let kept: std::collections::HashSet<u32> = new_order.iter().copied().collect();
    let to_delete: Vec<u32> = pages
        .keys()
        .copied()
        .filter(|n| !kept.contains(n))
        .collect();
    if !to_delete.is_empty() {
        doc.delete_pages(&to_delete);
    }
    doc.adjust_zero_pages();
    let _ = doc.prune_objects();
    save_modern(&mut doc)
}

/// Return basic document properties (title, author, subject, etc.) read from /Info.
fn pdf_object_string(obj: &Object) -> Option<String> {
    match obj {
        Object::String(bytes, _) => decode_pdf_string(bytes),
        Object::Name(name) => Some(String::from_utf8_lossy(name).into_owned()),
        _ => obj
            .as_str()
            .ok()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned()),
    }
}

fn decode_pdf_string(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    // UTF-16BE avec BOM (courant dans Info dict Adobe / Preview).
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        let mut i = 2;
        while i + 1 < bytes.len() {
            units.push(u16::from_be_bytes([bytes[i], bytes[i + 1]]));
            i += 2;
        }
        return Some(String::from_utf16_lossy(&units));
    }
    // UTF-16LE avec BOM.
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        let mut i = 2;
        while i + 1 < bytes.len() {
            units.push(u16::from_le_bytes([bytes[i], bytes[i + 1]]));
            i += 2;
        }
        return Some(String::from_utf16_lossy(&units));
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn info_get_str(info: Option<&lopdf::Dictionary>, key: &[u8]) -> Option<String> {
    let dict = info?;
    let obj = dict.get(key).ok()?;
    pdf_object_string(obj)
}

fn catalog_bool(doc: &Document, key: &[u8], nested: Option<&[u8]>) -> bool {
    let Ok(catalog) = doc.catalog() else {
        return false;
    };
    if let Some(nested_key) = nested {
        let Ok(nested_obj) = catalog.get(nested_key) else {
            return false;
        };
        let dict = match nested_obj {
            Object::Dictionary(d) => d,
            Object::Reference(id) => match doc.get_dictionary(*id) {
                Ok(d) => d,
                Err(_) => return false,
            },
            _ => return false,
        };
        return matches!(dict.get(key), Ok(Object::Boolean(true)));
    }
    matches!(catalog.get(key), Ok(Object::Boolean(true)))
}

fn catalog_name(doc: &Document, key: &[u8]) -> Option<String> {
    let catalog = doc.catalog().ok()?;
    match catalog.get(key).ok()? {
        Object::Name(name) => Some(String::from_utf8_lossy(name).into_owned()),
        Object::Reference(id) => match doc.get_object(*id).ok()? {
            Object::Name(name) => Some(String::from_utf8_lossy(name).into_owned()),
            _ => None,
        },
        _ => None,
    }
}

fn is_linearized(bytes: &[u8]) -> bool {
    // Le dict /Linearized est en tête de fichier (après %PDF-x.y).
    let head = &bytes[..bytes.len().min(2048)];
    head.windows(b"/Linearized".len())
        .any(|window| window == b"/Linearized")
}

fn first_page_size(doc: &Document) -> (Option<f64>, Option<f64>) {
    let pages = doc.get_pages();
    let Some((_, page_id)) = pages.iter().next() else {
        return (None, None);
    };
    let Ok(page) = doc.get_dictionary(*page_id) else {
        return (None, None);
    };
    let media = match page.get(b"MediaBox") {
        Ok(Object::Array(arr)) if arr.len() >= 4 => arr.clone(),
        Ok(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(arr)) if arr.len() >= 4 => arr.clone(),
            _ => return (None, None),
        },
        _ => return (None, None),
    };
    let num = |obj: &Object| -> Option<f64> {
        match obj {
            Object::Integer(v) => Some(*v as f64),
            Object::Real(v) => Some(f64::from(*v)),
            _ => None,
        }
    };
    match (num(&media[0]), num(&media[1]), num(&media[2]), num(&media[3])) {
        (Some(x0), Some(y0), Some(x1), Some(y1)) => (Some((x1 - x0).abs()), Some((y1 - y0).abs())),
        _ => (None, None),
    }
}

fn collect_fonts(doc: &Document) -> Vec<PdfFontInfo> {
    use std::collections::BTreeMap;
    let mut fonts: BTreeMap<String, PdfFontInfo> = BTreeMap::new();
    for (_num, page_id) in doc.get_pages() {
        let Ok(page) = doc.get_dictionary(page_id) else {
            continue;
        };
        let resources = match page.get(b"Resources") {
            Ok(Object::Dictionary(d)) => d.clone(),
            Ok(Object::Reference(id)) => match doc.get_dictionary(*id) {
                Ok(d) => d.clone(),
                Err(_) => continue,
            },
            _ => continue,
        };
        let font_dict = match resources.get(b"Font") {
            Ok(Object::Dictionary(d)) => d,
            Ok(Object::Reference(id)) => match doc.get_dictionary(*id) {
                Ok(d) => d,
                Err(_) => continue,
            },
            _ => continue,
        };
        for (_key, value) in font_dict.iter() {
            let font = match value {
                Object::Dictionary(d) => d,
                Object::Reference(id) => match doc.get_dictionary(*id) {
                    Ok(d) => d,
                    Err(_) => continue,
                },
                _ => continue,
            };
            let base = font
                .get(b"BaseFont")
                .ok()
                .and_then(pdf_object_string)
                .unwrap_or_else(|| "Sans nom".into());
            // Préfixe de sous-ensemble ABCDEF+…
            let display = if base.len() > 7 && base.as_bytes().get(6) == Some(&b'+') {
                base[7..].to_string()
            } else {
                base.clone()
            };
            let subtype = font
                .get(b"Subtype")
                .ok()
                .and_then(pdf_object_string)
                .unwrap_or_else(|| "Unknown".into());
            let encoding = font.get(b"Encoding").ok().and_then(pdf_object_string);
            let embedded = font.get(b"FontDescriptor").is_ok()
                || matches!(subtype.as_str(), "Type0" | "CIDFontType0" | "CIDFontType2");
            fonts.entry(display.clone()).or_insert(PdfFontInfo {
                name: display,
                subtype,
                encoding,
                embedded,
            });
        }
    }
    fonts.into_values().collect()
}

fn collect_custom_properties(info: Option<&lopdf::Dictionary>) -> Vec<PdfCustomProperty> {
    const STANDARD: &[&[u8]] = &[
        b"Title",
        b"Author",
        b"Subject",
        b"Keywords",
        b"Creator",
        b"Producer",
        b"CreationDate",
        b"ModDate",
        b"Trapped",
    ];
    let Some(dict) = info else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (key, value) in dict.iter() {
        if STANDARD.iter().any(|s| *s == key.as_slice()) {
            continue;
        }
        let name = String::from_utf8_lossy(key).into_owned();
        if name.starts_with("PTEX.") {
            continue;
        }
        if let Some(val) = pdf_object_string(value) {
            out.push(PdfCustomProperty { name, value: val });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn document_properties(bytes: Vec<u8>) -> Result<PdfProperties, String> {
    let doc = load_doc(&bytes)?;
    let pages = doc.get_pages();
    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .and_then(|id| doc.get_dictionary(id).ok());

    let tagged = catalog_bool(&doc, b"Marked", Some(b"MarkInfo"));
    let linearized = is_linearized(&bytes);
    let (page_width_pts, page_height_pts) = first_page_size(&doc);

    let encrypted = doc.is_encrypted();
    let security_method = if encrypted {
        "Mot de passe".to_string()
    } else {
        "Aucune".to_string()
    };

    Ok(PdfProperties {
        title: info_get_str(info, b"Title"),
        author: info_get_str(info, b"Author"),
        subject: info_get_str(info, b"Subject"),
        keywords: info_get_str(info, b"Keywords"),
        creator: info_get_str(info, b"Creator"),
        producer: info_get_str(info, b"Producer"),
        creation_date: info_get_str(info, b"CreationDate"),
        mod_date: info_get_str(info, b"ModDate"),
        page_count: pages.len() as u32,
        pdf_version: doc.version.clone(),
        file_size: bytes.len() as u64,
        encrypted,
        tagged,
        linearized,
        page_width_pts,
        page_height_pts,
        fonts: collect_fonts(&doc),
        custom_properties: collect_custom_properties(info),
        security_method,
        can_print: !encrypted,
        can_copy: !encrypted,
        can_modify: !encrypted,
        can_annotate: !encrypted,
        page_layout: catalog_name(&doc, b"PageLayout"),
        page_mode: catalog_name(&doc, b"PageMode"),
        trapped: info_get_str(info, b"Trapped"),
    })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PdfFontInfo {
    pub name: String,
    pub subtype: String,
    pub encoding: Option<String>,
    pub embedded: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PdfCustomProperty {
    pub name: String,
    pub value: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PdfProperties {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub mod_date: Option<String>,
    pub page_count: u32,
    pub pdf_version: String,
    pub file_size: u64,
    pub encrypted: bool,
    pub tagged: bool,
    pub linearized: bool,
    pub page_width_pts: Option<f64>,
    pub page_height_pts: Option<f64>,
    pub fonts: Vec<PdfFontInfo>,
    pub custom_properties: Vec<PdfCustomProperty>,
    pub security_method: String,
    pub can_print: bool,
    pub can_copy: bool,
    pub can_modify: bool,
    pub can_annotate: bool,
    pub page_layout: Option<String>,
    pub page_mode: Option<String>,
    pub trapped: Option<String>,
}
