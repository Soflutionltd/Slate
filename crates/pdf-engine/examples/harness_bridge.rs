//! Pont de test : expose les commandes natives d'édition (mêmes fonctions du
//! moteur que l'app Tauri) en HTTP local, pour faire tourner le frontend
//! desktop dans un navigateur avec le VRAI chemin PDFium.
//!
//! `cargo run --example harness_bridge -- [port]` (127.0.0.1 uniquement).
//! Requête : `POST /<commande>`, corps JSON des arguments, ou corps binaire
//! brut pour `stage_bytes`. Réponse : JSON, ou octets bruts
//! (`application/octet-stream`) pour les commandes qui renvoient un
//! `tauri::ipc::Response` dans l'app.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use alto_pdf_engine::pdf_versioning::{self, PageBaseline};
use alto_pdf_engine::{pdf_edit, pdf_engine};
use serde_json::{json, Value};

const MAX_BODY: usize = 512 * 1024 * 1024;

#[derive(Default)]
struct Bridge {
    docs: HashMap<String, Arc<Vec<u8>>>,
    views: HashMap<String, (u64, Arc<Vec<u8>>)>,
    baselines: HashMap<String, HashMap<u32, PageBaseline>>,
    staged: HashMap<u64, Vec<u8>>,
    next_token: u64,
}

enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

impl Bridge {
    fn stage(&mut self, bytes: Vec<u8>) -> String {
        self.next_token += 1;
        self.staged.insert(self.next_token, bytes);
        format!("staged:{}", self.next_token)
    }

    fn doc_bytes(&mut self, value: &Value) -> Result<Vec<u8>, String> {
        match value {
            Value::String(token) => token
                .strip_prefix("staged:")
                .and_then(|id| id.parse::<u64>().ok())
                .and_then(|id| self.staged.remove(&id))
                .ok_or_else(|| format!("staged_bytes_missing: {token}")),
            Value::Array(items) => items
                .iter()
                .map(|item| item.as_u64().and_then(|b| u8::try_from(b).ok()).ok_or("invalid_byte".to_string()))
                .collect(),
            _ => Err("bytes_required".to_string()),
        }
    }

    fn cached(&self, args: &Value) -> Result<Arc<Vec<u8>>, String> {
        self.docs.get(&text(args, "id")?).cloned().ok_or_else(|| "cache_miss".to_string())
    }

    fn handle(&mut self, command: &str, body: Vec<u8>) -> Result<Reply, String> {
        if command == "stage_bytes" {
            return Ok(Reply::Json(json!(self.stage(body))));
        }
        if command == "repair_pdf_bytes" {
            let repaired = alto_pdf_engine::pdf_mupdf::repair_pdf_if_needed(&body)?;
            return Ok(Reply::Bytes(repaired.unwrap_or_default()));
        }
        let args: Value = if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&body).map_err(|e| format!("invalid_json: {e}"))?
        };
        match command {
            "generate_pdf" => {
                if args["images"].as_array().is_some_and(|images| !images.is_empty()) {
                    return Err("bridge: images are not supported, test them in cargo tests".to_string());
                }
                let generated = alto_pdf_engine::pdf_generate::generate_pdf(&text(&args, "source")?, Vec::new())?;
                let token = self.stage(generated.bytes);
                Ok(Reply::Json(json!({ "bytes": token, "pages": generated.pages, "warnings": generated.warnings })))
            }
            "take_staged_bytes" => {
                let token = text(&args, "token")?;
                let bytes = self.doc_bytes(&json!(token))?;
                Ok(Reply::Bytes(bytes))
            }
            "cache_document" => {
                let bytes = self.doc_bytes(&args["bytes"])?;
                self.docs.insert(text(&args, "id")?, Arc::new(bytes));
                Ok(Reply::Json(Value::Null))
            }
            "cache_view_document" => {
                let bytes = Arc::new(self.doc_bytes(&args["bytes"])?);
                if let Some(doc) = args["doc"].as_str() {
                    self.docs.entry(doc.to_string()).or_insert_with(|| bytes.clone());
                }
                self.views.insert(text(&args, "tab")?, (number(&args, "generation")? as u64, bytes));
                Ok(Reply::Json(Value::Null))
            }
            "drop_view_document" => {
                self.views.remove(&text(&args, "tab")?);
                Ok(Reply::Json(Value::Null))
            }
            "render_view_page" => {
                let generation = number(&args, "generation")? as u64;
                let bytes = match self.views.get(&text(&args, "tab")?) {
                    Some((held, bytes)) if *held == generation => bytes.clone(),
                    _ => return Err("cache_miss".to_string()),
                };
                pdf_engine::render_page_rgba_for_view(
                    &bytes,
                    number(&args, "page")? as u32,
                    number(&args, "scale")?,
                    number(&args, "width")? as u32,
                    number(&args, "height")? as u32,
                )
                .map(Reply::Bytes)
            }
            "analyze_pdf_page_cached" => {
                let bytes = self.cached(&args)?;
                let analysis = pdf_engine::analyze_pdf_page(&bytes, number(&args, "page")? as u32)?;
                to_json(&analysis)
            }
            "edit_pdf_text_cached" => self.edit_text(&args),
            "restore_native_page" => {
                let id = text(&args, "id")?;
                let page = number(&args, "page")? as u32;
                let Some(snapshot) = self.baselines.get(&id).and_then(|pages| pages.get(&page)).cloned() else {
                    return Ok(Reply::Json(json!(false)));
                };
                let bytes = self.cached(&args)?;
                let restored = pdf_versioning::restore_page_baselines(&bytes, &[(page, snapshot)])?;
                self.docs.insert(id, Arc::new(restored));
                Ok(Reply::Json(json!(true)))
            }
            "render_pdf_page_cached" => {
                let bytes = self.cached(&args)?;
                let page = number(&args, "page")? as u32;
                let scale = number(&args, "scale")?;
                let regions = hidden_regions(&args["hidden"])?;
                let (png, _, _) = if regions.is_empty() {
                    pdf_engine::render_pdf_page_png_bytes(&bytes, page, scale)?
                } else {
                    pdf_edit::render_page_without_text(&bytes, page, scale, &regions)?
                };
                Ok(Reply::Bytes(png))
            }
            "render_pdf_thumbnail_cached" => {
                let bytes = self.cached(&args)?;
                pdf_engine::render_pdf_page_thumbnail(&bytes, number(&args, "page")? as u32, number(&args, "width")? as u32)
                    .map(Reply::Bytes)
            }
            "get_cached_document" => Ok(Reply::Bytes(self.cached(&args)?.to_vec())),
            "extract_embedded_fonts_cached" => {
                let bytes = self.cached(&args)?;
                to_json(&pdf_engine::extract_embedded_fonts(&bytes, number(&args, "page")? as u32)?)
            }
            _ => Err(format!("bridge_unknown_command: {command}")),
        }
    }

    fn edit_text(&mut self, args: &Value) -> Result<Reply, String> {
        let id = text(args, "id")?;
        let page = number(args, "page")? as u32;
        let bytes = self.cached(args)?;
        if let Entry::Vacant(slot) = self.baselines.entry(id.clone()).or_default().entry(page) {
            if let Ok(snapshot) = pdf_versioning::page_baseline(&bytes, page) {
                slot.insert(snapshot);
            }
        }
        let removed: Vec<u32> = serde_json::from_value(args["removed"].clone()).map_err(|e| e.to_string())?;
        let rect = args["blockRect"]
            .as_array()
            .filter(|r| r.len() == 4)
            .map(|r| (r[0].as_f64().unwrap_or(0.0), r[1].as_f64().unwrap_or(0.0), r[2].as_f64().unwrap_or(0.0), r[3].as_f64().unwrap_or(0.0)));
        let outcome = pdf_engine::edit_pdf_text_with_options(
            &bytes,
            page,
            &removed,
            number(args, "insertAfter")? as i64,
            number(args, "insertBefore")? as i64,
            &text(args, "inserted")?,
            number(args, "stripTop")?,
            number(args, "stripHeight")?,
            number(args, "scale")?,
            args["expectedBlockText"].as_str(),
            rect,
            args["replaceWhitespaceRun"].as_bool().unwrap_or(false),
        )?;
        self.docs.insert(id, Arc::new(outcome.bytes));
        to_json(&outcome.report)
    }
}

fn text(args: &Value, key: &str) -> Result<String, String> {
    args[key].as_str().map(str::to_string).ok_or_else(|| format!("missing_arg: {key}"))
}

fn number(args: &Value, key: &str) -> Result<f64, String> {
    args[key].as_f64().ok_or_else(|| format!("missing_arg: {key}"))
}

fn hidden_regions(value: &Value) -> Result<Vec<(f64, f64, f64, f64)>, String> {
    let Some(items) = value.as_array() else { return Ok(Vec::new()) };
    items
        .iter()
        .map(|region| {
            let r: Vec<f64> = serde_json::from_value(region.clone()).map_err(|e| e.to_string())?;
            match r.as_slice() {
                [x0, y0, x1, y1] if x1 > x0 && y1 > y0 => Ok((*x0, *y0, *x1, *y1)),
                _ => Err("invalid_hidden_region".to_string()),
            }
        })
        .collect()
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Reply, String> {
    serde_json::to_value(value).map(Reply::Json).map_err(|e| e.to_string())
}

fn read_request(stream: &TcpStream) -> Result<(String, String, Vec<u8>), String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).map_err(|e| e.to_string())?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().map_err(|_| "invalid_content_length".to_string())?;
            }
        }
    }
    if length > MAX_BODY {
        return Err("body_too_large".to_string());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok((method, path, body))
}

fn respond(mut stream: TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body));
}

fn main() {
    let port = std::env::args().nth(1).unwrap_or_else(|| "18766".to_string());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("port déjà pris");
    eprintln!("harness_bridge: http://127.0.0.1:{port}");
    let mut bridge = Bridge::default();
    for stream in listener.incoming().flatten() {
        let (method, path, body) = match read_request(&stream) {
            Ok(request) => request,
            Err(error) => {
                respond(stream, "400 Bad Request", "text/plain", error.as_bytes());
                continue;
            }
        };
        if method == "OPTIONS" {
            respond(stream, "204 No Content", "text/plain", b"");
            continue;
        }
        let command = path.trim_start_matches('/');
        match bridge.handle(command, body) {
            Ok(Reply::Json(value)) => respond(stream, "200 OK", "application/json", value.to_string().as_bytes()),
            Ok(Reply::Bytes(bytes)) => respond(stream, "200 OK", "application/octet-stream", &bytes),
            Err(error) => respond(stream, "500 Internal Server Error", "text/plain", error.as_bytes()),
        }
    }
}
