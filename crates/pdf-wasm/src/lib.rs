//! Bindings WASM pour le moteur PDF Slate (`alto-pdf-engine`).
//! Le module Pdfium WASM externe doit être initialisé côté JS avant tout appel
//! (voir `pdf-bridge.js`).

use alto_pdf_engine::{pdf_compress, pdf_engine, pdf_forms, pdf_ops, pdf_tools};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js_err(message: String) -> JsError {
    JsError::new(&message)
}

fn to_json<T: Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| to_js_err(e.to_string()))
}

// --- Analyse & export ---

#[wasm_bindgen]
pub fn analyze_pdf_page(bytes: &[u8], page: u32) -> Result<String, JsError> {
    let analysis = pdf_engine::analyze_pdf_page(bytes, page).map_err(to_js_err)?;
    to_json(&analysis)
}

#[wasm_bindgen]
pub fn export_edited_pdf(pages_json: &str) -> Result<Vec<u8>, JsError> {
    let pages: Vec<pdf_engine::FlattenedPage> =
        serde_json::from_str(pages_json).map_err(|e| to_js_err(e.to_string()))?;
    pdf_engine::export_flattened_pdf(pages).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn repair_pdf(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    pdf_engine::repair_pdf(bytes).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn remove_blank_pages(bytes: &[u8]) -> Result<String, JsError> {
    let (out, removed) = pdf_engine::remove_blank_pages(bytes).map_err(to_js_err)?;
    to_json(&serde_json::json!({
        "bytes": out,
        "removed": removed
    }))
}

// --- Opérations structurelles ---

#[wasm_bindgen]
pub fn merge_pdfs(sources: JsValue) -> Result<Vec<u8>, JsError> {
    let sources: Vec<Vec<u8>> =
        serde_wasm_bindgen::from_value(sources).map_err(|e| to_js_err(e.to_string()))?;
    pdf_ops::merge_pdfs(sources).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn encrypt_pdf(bytes: &[u8], user_password: &str, owner_password: Option<String>) -> Result<Vec<u8>, JsError> {
    pdf_ops::encrypt_pdf(bytes.to_vec(), user_password.to_string(), owner_password).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn compress_pdf(bytes: &[u8], level: Option<String>) -> Result<Vec<u8>, JsError> {
    let level = level.unwrap_or_else(|| "medium".to_string());
    pdf_compress::compress_pdf_images(bytes.to_vec(), &level).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn remove_annotations(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    pdf_ops::remove_annotations(bytes.to_vec()).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn rotate_pages(bytes: &[u8], page_numbers: JsValue, angle: i32) -> Result<Vec<u8>, JsError> {
    let page_numbers: Vec<u32> =
        serde_wasm_bindgen::from_value(page_numbers).map_err(|e| to_js_err(e.to_string()))?;
    pdf_ops::rotate_pages(bytes.to_vec(), page_numbers, angle).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn delete_pages(bytes: &[u8], page_numbers: JsValue) -> Result<Vec<u8>, JsError> {
    let page_numbers: Vec<u32> =
        serde_wasm_bindgen::from_value(page_numbers).map_err(|e| to_js_err(e.to_string()))?;
    pdf_ops::delete_pages(bytes.to_vec(), page_numbers).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn extract_pages(bytes: &[u8], page_numbers: JsValue) -> Result<Vec<u8>, JsError> {
    let page_numbers: Vec<u32> =
        serde_wasm_bindgen::from_value(page_numbers).map_err(|e| to_js_err(e.to_string()))?;
    pdf_ops::extract_pages(bytes.to_vec(), page_numbers).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn reorder_pages(bytes: &[u8], new_order: JsValue) -> Result<Vec<u8>, JsError> {
    let new_order: Vec<u32> =
        serde_wasm_bindgen::from_value(new_order).map_err(|e| to_js_err(e.to_string()))?;
    pdf_ops::reorder_pages(bytes.to_vec(), new_order).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn page_count(bytes: &[u8]) -> Result<u32, JsError> {
    pdf_ops::page_count(bytes.to_vec()).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn document_properties(bytes: &[u8]) -> Result<String, JsError> {
    let props = pdf_ops::document_properties(bytes.to_vec()).map_err(to_js_err)?;
    to_json(&props)
}

// --- Outils ---

#[wasm_bindgen]
pub fn watermark_pdf(
    bytes: &[u8],
    text: &str,
    font_size: f64,
    opacity: f64,
    rotation: f64,
    color: Option<Vec<u8>>,
    bold: bool,
) -> Result<Vec<u8>, JsError> {
    let rgb = color.and_then(|c| {
        if c.len() >= 3 {
            Some([c[0], c[1], c[2]])
        } else {
            None
        }
    });
    pdf_tools::watermark_text(bytes, text, font_size, opacity, rotation, rgb, bold).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn add_page_numbers(
    bytes: &[u8],
    position: &str,
    start_at: i64,
    font_size: f64,
    margin: f64,
) -> Result<Vec<u8>, JsError> {
    pdf_tools::add_page_numbers(bytes, position, start_at, font_size, margin).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn images_to_pdf(images: JsValue) -> Result<Vec<u8>, JsError> {
    let images: Vec<Vec<u8>> =
        serde_wasm_bindgen::from_value(images).map_err(|e| to_js_err(e.to_string()))?;
    pdf_tools::images_to_pdf(images).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn remove_password(bytes: &[u8], password: &str) -> Result<Vec<u8>, JsError> {
    pdf_tools::remove_password(bytes, password).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn crop_pdf(bytes: &[u8], left: f64, top: f64, right: f64, bottom: f64) -> Result<Vec<u8>, JsError> {
    pdf_tools::crop_pages(bytes, left, top, right, bottom).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn flatten_pdf(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    pdf_tools::flatten(bytes).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn sanitize_pdf(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    pdf_tools::sanitize(bytes).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn auto_redact(bytes: &[u8], terms: JsValue, match_case: bool) -> Result<String, JsError> {
    let terms: Vec<String> =
        serde_wasm_bindgen::from_value(terms).map_err(|e| to_js_err(e.to_string()))?;
    let (out, count) = pdf_tools::auto_redact(bytes, &terms, match_case).map_err(to_js_err)?;
    to_json(&serde_json::json!({
        "bytes": out,
        "count": count
    }))
}

#[wasm_bindgen]
pub fn get_bookmarks(bytes: &[u8]) -> Result<String, JsError> {
    let items = pdf_tools::get_bookmarks(bytes).map_err(to_js_err)?;
    to_json(&items)
}

#[wasm_bindgen]
pub fn set_bookmarks(bytes: &[u8], items_json: &str) -> Result<Vec<u8>, JsError> {
    let items: Vec<pdf_tools::BookmarkItem> =
        serde_json::from_str(items_json).map_err(|e| to_js_err(e.to_string()))?;
    pdf_tools::set_bookmarks(bytes, &items).map_err(to_js_err)
}

// --- Formulaires ---

#[wasm_bindgen]
pub fn list_form_fields(bytes: &[u8]) -> Result<String, JsError> {
    let fields = pdf_forms::list_form_fields(bytes).map_err(to_js_err)?;
    to_json(&fields)
}

#[wasm_bindgen]
pub fn fill_form_fields(bytes: &[u8], values_json: &str) -> Result<Vec<u8>, JsError> {
    let values: std::collections::HashMap<String, String> =
        serde_json::from_str(values_json).map_err(|e| to_js_err(e.to_string()))?;
    pdf_forms::fill_form_fields(bytes, values).map_err(to_js_err)
}
