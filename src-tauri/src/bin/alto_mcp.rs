// alto-mcp — serveur MCP (Model Context Protocol) stdio pour Alto PDF.
//
// Permet à Claude Desktop, ChatGPT ou tout client MCP de piloter les outils
// PDF d'Alto (lecture, fusion, rotation, compression, protection, redressement,
// OCR...) directement sur des fichiers locaux. Transport stdio : JSON-RPC 2.0,
// un message JSON par ligne.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use sofdocs_desktop::{ocr, pdf_edit, pdf_engine, pdf_ops};

const SERVER_NAME: &str = "alto-pdf";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: &str = "2024-11-05";

fn main() {
    // Voir main.rs : le moteur PDF étant dans le crate `alto-pdf-engine`, on expose
    // `src-tauri` (où se trouve la dylib PDFium en dev/CI) comme dossier de recherche.
    if std::env::var_os("ALTO_PDFIUM_DIR").is_none() {
        std::env::set_var("ALTO_PDFIUM_DIR", env!("CARGO_MANIFEST_DIR"));
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        // Notifications (sans id) : rien à répondre.
        let Some(id) = id else { continue };

        let response = match method.as_str() {
            "initialize" => handle_initialize(&params),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_descriptors() })),
            "tools/call" => handle_tool_call(&params),
            _ => Err((-32601, format!("Method not found: {method}"))),
        };

        let payload = match response {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message }
            }),
        };

        if writeln!(stdout, "{payload}").is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

fn handle_initialize(params: &Value) -> Result<Value, (i64, String)> {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);
    Ok(json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    }))
}

fn handle_tool_call(params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "Missing tool name".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

    match run_tool(name, &arguments) {
        Ok(text) => Ok(json!({
            "content": [{ "type": "text", "text": text }],
            "isError": false
        })),
        Err(message) => Ok(json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        })),
    }
}

fn tool_descriptors() -> Value {
    let path_prop = json!({ "type": "string", "description": "Absolute path to the PDF file" });
    let output_prop = json!({
        "type": "string",
        "description": "Absolute output path. Optional: defaults to a new file next to the source (the source is never overwritten)."
    });
    let pages_prop = json!({
        "type": "array",
        "items": { "type": "integer" },
        "description": "1-based page numbers"
    });

    json!([
        {
            "name": "pdf_info",
            "description": "Read PDF document properties: page count, page dimensions, metadata (title, author...), file size.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_read_text",
            "description": "Extract the text content of a PDF. Returns the text of one page, or of the whole document when no page is given.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "page": { "type": "integer", "description": "1-based page number. Omit for the whole document." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_merge",
            "description": "Merge several PDF files into one, in the given order.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Absolute paths of the PDFs to merge, in order" },
                    "output_path": output_prop
                },
                "required": ["paths"]
            }
        },
        {
            "name": "pdf_rotate_pages",
            "description": "Rotate specific pages of a PDF by 90, 180 or 270 degrees (or -90).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "pages": pages_prop,
                    "angle": { "type": "integer", "enum": [90, 180, 270, -90], "description": "Rotation angle in degrees, clockwise" },
                    "output_path": output_prop
                },
                "required": ["path", "pages", "angle"]
            }
        },
        {
            "name": "pdf_delete_pages",
            "description": "Delete specific pages from a PDF.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop, "pages": pages_prop, "output_path": output_prop },
                "required": ["path", "pages"]
            }
        },
        {
            "name": "pdf_extract_pages",
            "description": "Extract specific pages of a PDF into a new document.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop, "pages": pages_prop, "output_path": output_prop },
                "required": ["path", "pages"]
            }
        },
        {
            "name": "pdf_replace_text",
            "description": "Replace ALL occurrences of a text in a PDF (match inside a text run). Keeps the original font; if the replacement is wider than the original bbox, the block is scaled down to fit. Set regex=true to use a regular expression (Rust regex syntax). Returns how many occurrences were replaced. Tip: call pdf_layout first to see the exact text runs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "find": { "type": "string", "description": "Exact text to find, or a regex when regex=true" },
                    "replace": { "type": "string", "description": "Replacement text (supports $1 capture groups in regex mode)" },
                    "regex": { "type": "boolean", "description": "Treat 'find' as a regular expression. Default false." },
                    "page": { "type": "integer", "description": "1-based page number. Omit to replace in the whole document." },
                    "output_path": output_prop
                },
                "required": ["path", "find", "replace"]
            }
        },
        {
            "name": "pdf_layout",
            "description": "Inspect the exact structure of a PDF: every text block (block_id, bbox, text, font, size, color) and every image (image_id, bbox, width, height, colorspace). CALL THIS FIRST before pdf_edit_region, pdf_replace_image or pdf_delete_image: it provides the block_id / image_id and bbox values those tools need. Coordinates: origin at the TOP-LEFT of the page, y axis pointing DOWN, unit = PDF points (72 per inch); bbox = [x0, y0, x1, y1].",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "pages": { "type": "array", "items": { "type": "integer" }, "description": "1-based page numbers to inspect. Omit for all pages." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_edit_region",
            "description": "Edit a targeted region: truly redacts the area (underlying text is removed, not just hidden) then writes new_text inside the same bbox, auto-shrinking the font until it fits (a warning is returned if shrunk by more than 30%). Target the region either with block_id from pdf_layout (call it first) or with an explicit bbox. Coordinates: top-left origin, y down, points; bbox = [x0, y0, x1, y1].",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "page": { "type": "integer", "description": "1-based page number (required with bbox; ignored with block_id)" },
                    "bbox": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[x0, y0, x1, y1] in points, top-left origin" },
                    "block_id": { "type": "string", "description": "Text block id from pdf_layout, e.g. 'p1-t12'. Preferred over bbox." },
                    "new_text": { "type": "string", "description": "New text. Empty string just erases the region." },
                    "font": { "type": "string", "description": "helvetica (default), helvetica-bold, helvetica-oblique, times, times-bold, times-italic, courier, courier-bold" },
                    "size": { "type": "number", "description": "Font size in points. Default: size of the removed text, else 11." },
                    "color": { "type": "array", "items": { "type": "integer" }, "minItems": 3, "maxItems": 3, "description": "[r, g, b] 0-255. Default black." },
                    "align": { "type": "string", "enum": ["left", "center", "right", "justify"], "description": "Default left. justify falls back to left." },
                    "output_path": output_prop
                },
                "required": ["path", "new_text"]
            }
        },
        {
            "name": "pdf_replace_image",
            "description": "Replace an existing image (logo, visual) with a new PNG/JPEG file, keeping the original position, scale and rotation. Requires the image_id returned by pdf_layout: CALL pdf_layout FIRST.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "image_id": { "type": "string", "description": "Image id from pdf_layout, e.g. 'p1-i3'" },
                    "new_image_path": { "type": "string", "description": "Absolute path to the new PNG or JPEG image" },
                    "output_path": output_prop
                },
                "required": ["path", "image_id", "new_image_path"]
            }
        },
        {
            "name": "pdf_insert_image",
            "description": "Insert a PNG/JPEG image (logo, visual) into a given rectangle of a page. Coordinates: top-left origin, y down, points; rect = [x0, y0, x1, y1]. keep_aspect=true (default) fits the image inside the rect without distortion.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "page": { "type": "integer", "description": "1-based page number" },
                    "rect": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[x0, y0, x1, y1] in points, top-left origin" },
                    "image_path": { "type": "string", "description": "Absolute path to the PNG or JPEG image" },
                    "keep_aspect": { "type": "boolean", "description": "Preserve the image aspect ratio inside the rect. Default true." },
                    "overlay": { "type": "boolean", "description": "Default true. false (background) is not supported by the engine and falls back to foreground with a warning." },
                    "output_path": output_prop
                },
                "required": ["path", "page", "rect", "image_path"]
            }
        },
        {
            "name": "pdf_delete_image",
            "description": "Delete an image from a page and purge the orphaned object from the file. Requires the image_id returned by pdf_layout: CALL pdf_layout FIRST.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "image_id": { "type": "string", "description": "Image id from pdf_layout, e.g. 'p2-i0'" },
                    "output_path": output_prop
                },
                "required": ["path", "image_id"]
            }
        },
        {
            "name": "pdf_redact",
            "description": "Legally redact areas of a PDF: the text under each area is REALLY REMOVED from the file (it cannot be recovered by copy-paste or text extraction), then a black rectangle is drawn on top. Optionally removes intersecting images too. Use pdf_layout first to find the exact bboxes to redact. Coordinates: top-left origin, y down, points; bbox = [x0, y0, x1, y1].",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "areas": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "page": { "type": "integer", "description": "1-based page number" },
                                "bbox": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 }
                            },
                            "required": ["page", "bbox"]
                        },
                        "description": "Areas to redact"
                    },
                    "remove_images": { "type": "boolean", "description": "Also remove images intersecting the areas. Default false." },
                    "output_path": output_prop
                },
                "required": ["path", "areas"]
            }
        },
        {
            "name": "pdf_set_metadata",
            "description": "Update PDF metadata (title, author, subject, keywords). Only the provided fields are changed; the others are preserved. Fixes documents that ship with a wrong or parasitic title.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "title": { "type": "string" },
                    "author": { "type": "string" },
                    "subject": { "type": "string" },
                    "keywords": { "type": "string" },
                    "output_path": output_prop
                },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_stamp",
            "description": "Stamp a short text (mention, date, 'lu et approuvé') or a PNG/JPEG image (e.g. scanned signature) at a position on a page. Position = top-left corner of the stamp, in points, top-left origin, y down.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "page": { "type": "integer", "description": "1-based page number" },
                    "position": {
                        "type": "object",
                        "properties": { "x": { "type": "number" }, "y": { "type": "number" } },
                        "required": ["x", "y"],
                        "description": "Top-left corner of the stamp, in points (top-left origin)"
                    },
                    "text": { "type": "string", "description": "Text to stamp (provide either text or image_path)" },
                    "font": { "type": "string", "description": "helvetica (default), helvetica-bold, times, courier..." },
                    "size": { "type": "number", "description": "Text size in points. Default 12." },
                    "color": { "type": "array", "items": { "type": "integer" }, "minItems": 3, "maxItems": 3, "description": "[r, g, b] 0-255. Default black." },
                    "image_path": { "type": "string", "description": "Absolute path to a PNG/JPEG to stamp (e.g. signature)" },
                    "image_width": { "type": "number", "description": "Stamp width in points. Default: natural image size (1px = 0.75pt)." },
                    "output_path": output_prop
                },
                "required": ["path", "page", "position"]
            }
        },
        {
            "name": "pdf_reorder_pages",
            "description": "Reorder the pages of a PDF according to a 1-based permutation. Pages not listed are dropped.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "order": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "New page order, 1-based. Example: [3,1,2]"
                    },
                    "output_path": output_prop
                },
                "required": ["path", "order"]
            }
        },
        {
            "name": "pdf_split",
            "description": "Split a PDF into several files. Provide page ranges, or omit them to get one file per page. Output files are written next to the source.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "ranges": {
                        "type": "array",
                        "items": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "minItems": 2,
                            "maxItems": 2
                        },
                        "description": "1-based inclusive page ranges, e.g. [[1,3],[4,10]]. Omit for one file per page."
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_compress",
            "description": "Compress a PDF to reduce its file size.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop, "output_path": output_prop },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_protect",
            "description": "Protect a PDF with a password (AES encryption).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "password": { "type": "string", "description": "Password required to open the document" },
                    "output_path": output_prop
                },
                "required": ["path", "password"]
            }
        },
        {
            "name": "pdf_deskew",
            "description": "Detect and straighten skewed scanned pages (auto-deskew). Returns which pages were corrected and by which angle.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop, "output_path": output_prop },
                "required": ["path"]
            }
        },
        {
            "name": "pdf_ocr",
            "description": "Run local OCR (Apple Vision, Tesseract fallback) on one page of a PDF and return the recognized text blocks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop,
                    "page": { "type": "integer", "description": "1-based page number" },
                    "language": { "type": "string", "description": "OCR language hint, e.g. 'fra' or 'eng'" }
                },
                "required": ["path", "page"]
            }
        }
    ])
}

fn run_tool(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "pdf_info" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let properties = pdf_ops::document_properties(bytes)?;
            serde_json::to_string_pretty(&properties).map_err(|e| e.to_string())
        }
        "pdf_read_text" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let page = args.get("page").and_then(Value::as_u64).map(|p| p as u32);
            read_pdf_text(&bytes, page)
        }
        "pdf_merge" => {
            let paths = args
                .get("paths")
                .and_then(Value::as_array)
                .ok_or("Missing 'paths'")?
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect::<Vec<_>>();
            if paths.len() < 2 {
                return Err("Provide at least two PDF paths to merge.".to_string());
            }
            let mut sources = Vec::new();
            for path in &paths {
                sources.push(read_pdf(path)?);
            }
            let merged = pdf_ops::merge_pdfs(sources)?;
            let output = output_path(args, &paths[0], "fusionne")?;
            write_output(&output, &merged)?;
            Ok(format!("Merged {} files into {}", paths.len(), output.display()))
        }
        "pdf_rotate_pages" => {
            let path = required_path(args)?;
            let pages = required_pages(args)?;
            let angle = args
                .get("angle")
                .and_then(Value::as_i64)
                .ok_or("Missing 'angle'")? as i32;
            let bytes = read_pdf(&path)?;
            let rotated = pdf_ops::rotate_pages(bytes, pages.clone(), angle)?;
            let output = output_path(args, &path, "pivote")?;
            write_output(&output, &rotated)?;
            Ok(format!(
                "Rotated pages {pages:?} by {angle}° -> {}",
                output.display()
            ))
        }
        "pdf_delete_pages" => {
            let path = required_path(args)?;
            let pages = required_pages(args)?;
            let bytes = read_pdf(&path)?;
            let result = pdf_ops::delete_pages(bytes, pages.clone())?;
            let output = output_path(args, &path, "pages-supprimees")?;
            write_output(&output, &result)?;
            Ok(format!("Deleted pages {pages:?} -> {}", output.display()))
        }
        "pdf_extract_pages" => {
            let path = required_path(args)?;
            let pages = required_pages(args)?;
            let bytes = read_pdf(&path)?;
            let result = pdf_ops::extract_pages(bytes, pages.clone())?;
            let output = output_path(args, &path, "extrait")?;
            write_output(&output, &result)?;
            Ok(format!("Extracted pages {pages:?} -> {}", output.display()))
        }
        "pdf_replace_text" => {
            let path = required_path(args)?;
            let find = args
                .get("find")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("Missing 'find'")?;
            let replace = args
                .get("replace")
                .and_then(Value::as_str)
                .ok_or("Missing 'replace'")?;
            let use_regex = args
                .get("regex")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let page = args.get("page").and_then(Value::as_u64).map(|p| p as u32);
            let bytes = read_pdf(&path)?;
            let outcome = pdf_edit::replace_text(&bytes, find, replace, page, use_regex)?;
            if outcome.count == 0 {
                return Err(format!(
                    "Text '{find}' not found as a single text run. Use pdf_layout or pdf_read_text to inspect the exact runs."
                ));
            }
            let output = output_path(args, &path, "texte-remplace")?;
            write_output(&output, &outcome.bytes)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "replaced": outcome.count,
                "shrunk_blocks": outcome.shrunk_blocks
            }))
        }
        "pdf_layout" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let pages = args.get("pages").and_then(Value::as_array).map(|raw| {
                raw.iter()
                    .filter_map(Value::as_u64)
                    .map(|p| p as u32)
                    .collect::<Vec<_>>()
            });
            let mut layout = pdf_edit::layout(&bytes, pages)?;
            if let Some(map) = layout.as_object_mut() {
                map.insert("success".to_string(), json!(true));
                map.insert(
                    "input_path".to_string(),
                    json!(path.display().to_string()),
                );
            }
            json_result(layout)
        }
        "pdf_edit_region" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let new_text = args
                .get("new_text")
                .and_then(Value::as_str)
                .ok_or("Missing 'new_text' (use an empty string to just erase the region)")?;

            // Cible : block_id (issu de pdf_layout) ou page + bbox explicite.
            let (page, bbox) = if let Some(block_id) =
                args.get("block_id").and_then(Value::as_str).filter(|s| !s.is_empty())
            {
                pdf_edit::resolve_block_bbox(&bytes, block_id)?
            } else {
                let page = args
                    .get("page")
                    .and_then(Value::as_u64)
                    .ok_or("Provide 'block_id' (from pdf_layout) or 'page' + 'bbox'.")?
                    as u32;
                let bbox = pdf_edit::parse_bbox(
                    args.get("bbox")
                        .ok_or("Provide 'block_id' (from pdf_layout) or 'page' + 'bbox'.")?,
                )?;
                (page, bbox)
            };

            let font = args.get("font").and_then(Value::as_str);
            let size = args.get("size").and_then(Value::as_f64);
            let color = pdf_edit::parse_color(args.get("color"))?;
            let align = args.get("align").and_then(Value::as_str).unwrap_or("left");

            let outcome =
                pdf_edit::edit_region(&bytes, page, bbox, new_text, font, size, color, align)?;
            let output = output_path(args, &path, "zone-modifiee")?;
            write_output(&output, &outcome.bytes)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "page": page,
                "bbox": [bbox.0, bbox.1, bbox.2, bbox.3],
                "removed_text_blocks": outcome.removed_blocks,
                "final_font_size": outcome.final_size,
                "warnings": outcome.warnings
            }))
        }
        "pdf_replace_image" => {
            let path = required_path(args)?;
            let image_id = args
                .get("image_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("Missing 'image_id' (call pdf_layout first)")?;
            let new_image_path = args
                .get("new_image_path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("Missing 'new_image_path'")?;
            let bytes = read_pdf(&path)?;
            let result = pdf_edit::replace_image(&bytes, image_id, new_image_path)?;
            let output = output_path(args, &path, "image-remplacee")?;
            write_output(&output, &result)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "image_id": image_id
            }))
        }
        "pdf_insert_image" => {
            let path = required_path(args)?;
            let page = args
                .get("page")
                .and_then(Value::as_u64)
                .ok_or("Missing 'page'")? as u32;
            let rect = pdf_edit::parse_bbox(args.get("rect").ok_or("Missing 'rect'")?)?;
            let image_path = args
                .get("image_path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("Missing 'image_path'")?;
            let keep_aspect = args
                .get("keep_aspect")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let overlay = args.get("overlay").and_then(Value::as_bool).unwrap_or(true);
            let bytes = read_pdf(&path)?;
            let (result, warnings) =
                pdf_edit::insert_image(&bytes, page, rect, image_path, keep_aspect, overlay)?;
            let output = output_path(args, &path, "image-inseree")?;
            write_output(&output, &result)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "page": page,
                "warnings": warnings
            }))
        }
        "pdf_delete_image" => {
            let path = required_path(args)?;
            let image_id = args
                .get("image_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("Missing 'image_id' (call pdf_layout first)")?;
            let bytes = read_pdf(&path)?;
            let result = pdf_edit::delete_image(&bytes, image_id)?;
            let output = output_path(args, &path, "image-supprimee")?;
            write_output(&output, &result)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "image_id": image_id
            }))
        }
        "pdf_redact" => {
            let path = required_path(args)?;
            let raw_areas = args
                .get("areas")
                .and_then(Value::as_array)
                .ok_or("Missing 'areas': [{ page, bbox }]")?;
            let mut areas = Vec::new();
            for entry in raw_areas {
                let page = entry
                    .get("page")
                    .and_then(Value::as_u64)
                    .ok_or("Each area needs a 1-based 'page'")? as u32;
                let bbox =
                    pdf_edit::parse_bbox(entry.get("bbox").ok_or("Each area needs a 'bbox'")?)?;
                areas.push((page, bbox));
            }
            let remove_images = args
                .get("remove_images")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let bytes = read_pdf(&path)?;
            let outcome = pdf_edit::redact(&bytes, &areas, remove_images)?;
            let output = output_path(args, &path, "caviarde")?;
            write_output(&output, &outcome.bytes)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "areas": areas.len(),
                "removed_text_blocks": outcome.removed_text_blocks,
                "removed_images": outcome.removed_images
            }))
        }
        "pdf_set_metadata" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let title = args.get("title").and_then(Value::as_str);
            let author = args.get("author").and_then(Value::as_str);
            let subject = args.get("subject").and_then(Value::as_str);
            let keywords = args.get("keywords").and_then(Value::as_str);
            let result = pdf_edit::set_metadata(&bytes, title, author, subject, keywords)?;
            let output = output_path(args, &path, "metadonnees")?;
            write_output(&output, &result)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "updated": {
                    "title": title,
                    "author": author,
                    "subject": subject,
                    "keywords": keywords
                }
            }))
        }
        "pdf_stamp" => {
            let path = required_path(args)?;
            let page = args
                .get("page")
                .and_then(Value::as_u64)
                .ok_or("Missing 'page'")? as u32;
            let position = args.get("position").ok_or("Missing 'position' { x, y }")?;
            let x = position
                .get("x")
                .and_then(Value::as_f64)
                .ok_or("Missing position.x")?;
            let y = position
                .get("y")
                .and_then(Value::as_f64)
                .ok_or("Missing position.y")?;
            let text = args.get("text").and_then(Value::as_str).filter(|s| !s.is_empty());
            let image_path = args
                .get("image_path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let font = args.get("font").and_then(Value::as_str);
            let size = args.get("size").and_then(Value::as_f64).unwrap_or(12.0);
            let color = pdf_edit::parse_color(args.get("color"))?;
            let image_width = args.get("image_width").and_then(Value::as_f64);
            let bytes = read_pdf(&path)?;
            let result = pdf_edit::stamp(
                &bytes, page, x, y, text, font, size, color, image_path, image_width,
            )?;
            let output = output_path(args, &path, "estampille")?;
            write_output(&output, &result)?;
            json_result(json!({
                "success": true,
                "input_path": path.display().to_string(),
                "output_path": output.display().to_string(),
                "page": page,
                "stamp": if text.is_some() { "text" } else { "image" }
            }))
        }
        "pdf_reorder_pages" => {
            let path = required_path(args)?;
            let order = args
                .get("order")
                .and_then(Value::as_array)
                .ok_or("Missing 'order'")?
                .iter()
                .filter_map(Value::as_u64)
                .map(|p| p as u32)
                .collect::<Vec<_>>();
            if order.is_empty() {
                return Err("Provide the new page order.".to_string());
            }
            let bytes = read_pdf(&path)?;
            let result = pdf_ops::reorder_pages(bytes, order.clone())?;
            let output = output_path(args, &path, "reordonne")?;
            write_output(&output, &result)?;
            Ok(format!("Reordered pages to {order:?} -> {}", output.display()))
        }
        "pdf_split" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let total = pdf_ops::page_count(bytes.clone())?;
            let ranges: Vec<(u32, u32)> = match args.get("ranges").and_then(Value::as_array) {
                Some(raw) => {
                    let mut parsed = Vec::new();
                    for entry in raw {
                        let pair = entry
                            .as_array()
                            .filter(|p| p.len() == 2)
                            .ok_or("Each range must be a pair [start, end].")?;
                        let start = pair[0].as_u64().ok_or("Invalid range start")? as u32;
                        let end = pair[1].as_u64().ok_or("Invalid range end")? as u32;
                        if start == 0 || end < start || end > total {
                            return Err(format!(
                                "Invalid range [{start}, {end}] (document has {total} pages)."
                            ));
                        }
                        parsed.push((start, end));
                    }
                    if parsed.is_empty() {
                        return Err("Provide at least one range.".to_string());
                    }
                    parsed
                }
                None => (1..=total).map(|p| (p, p)).collect(),
            };

            let mut written = Vec::new();
            for (index, (start, end)) in ranges.iter().enumerate() {
                let pages: Vec<u32> = (*start..=*end).collect();
                let part = pdf_ops::extract_pages(bytes.clone(), pages)?;
                let output = output_path(&json!({}), &path, &format!("partie-{}", index + 1))?;
                write_output(&output, &part)?;
                written.push(format!(
                    "pages {start}-{end} -> {}",
                    output.display()
                ));
            }
            Ok(format!(
                "Split into {} file(s):\n{}",
                written.len(),
                written.join("\n")
            ))
        }
        "pdf_compress" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let original_size = bytes.len();
            let result = pdf_ops::compress_pdf(bytes)?;
            let output = output_path(args, &path, "compresse")?;
            write_output(&output, &result)?;
            Ok(format!(
                "Compressed {} -> {} ({} -> {} bytes)",
                path.display(),
                output.display(),
                original_size,
                result.len()
            ))
        }
        "pdf_protect" => {
            let path = required_path(args)?;
            let password = args
                .get("password")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .ok_or("Missing 'password'")?;
            let bytes = read_pdf(&path)?;
            let result =
                pdf_ops::encrypt_pdf(bytes, password.to_string(), Some(password.to_string()))?;
            let output = output_path(args, &path, "protege")?;
            write_output(&output, &result)?;
            Ok(format!("Protected PDF written to {}", output.display()))
        }
        "pdf_deskew" => {
            let path = required_path(args)?;
            let bytes = read_pdf(&path)?;
            let result = ocr::deskew_pdf(&bytes)?;
            if result.corrected.is_empty() {
                return Ok("No skew detected; document left unchanged.".to_string());
            }
            let output = output_path(args, &path, "redresse")?;
            write_output(&output, &result.bytes)?;
            let detail = result
                .corrected
                .iter()
                .map(|p| format!("page {} ({:+.1}°)", p.page, p.angle))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "Straightened {} -> {}",
                detail,
                output.display()
            ))
        }
        "pdf_ocr" => {
            let path = required_path(args)?;
            let page = args
                .get("page")
                .and_then(Value::as_u64)
                .ok_or("Missing 'page'")? as u32;
            let language = args
                .get("language")
                .and_then(Value::as_str)
                .map(str::to_string);
            let bytes = read_pdf(&path)?;
            let result = ocr::recognize_pdf_page(&bytes, page, language)?;
            let text = result
                .blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            Ok(if text.is_empty() {
                "No text recognized on this page.".to_string()
            } else {
                text
            })
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn required_path(args: &Value) -> Result<PathBuf, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Missing 'path'".to_string())?;
    if !path.is_absolute() {
        return Err(format!(
            "Path must be absolute: {}",
            path.display()
        ));
    }
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }
    Ok(path)
}

fn json_result(value: Value) -> Result<String, String> {
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn required_pages(args: &Value) -> Result<Vec<u32>, String> {
    let pages = args
        .get("pages")
        .and_then(Value::as_array)
        .ok_or("Missing 'pages'")?
        .iter()
        .filter_map(Value::as_u64)
        .map(|p| p as u32)
        .collect::<Vec<_>>();
    if pages.is_empty() {
        return Err("Provide at least one page number.".to_string());
    }
    Ok(pages)
}

fn read_pdf(path: &Path) -> Result<Vec<u8>, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Unable to read {}: {e}", path.display()))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err(format!("{} is not a PDF file.", path.display()));
    }
    Ok(bytes)
}

/// Chemin de sortie : fourni explicitement, sinon "<source>-<suffixe>.pdf" à
/// côté du fichier source. Le fichier source n'est jamais écrasé.
fn output_path(args: &Value, source: &Path, suffix: &str) -> Result<PathBuf, String> {
    if let Some(output) = args
        .get("output_path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    {
        let output = PathBuf::from(output);
        if output == source {
            return Err("Refusing to overwrite the source file; choose another output path.".to_string());
        }
        return Ok(output);
    }
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let mut candidate = source.with_file_name(format!("{stem}-{suffix}.pdf"));
    let mut counter = 2;
    while candidate.exists() {
        candidate = source.with_file_name(format!("{stem}-{suffix}-{counter}.pdf"));
        counter += 1;
    }
    Ok(candidate)
}

fn write_output(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("Unable to write {}: {e}", path.display()))
}


fn read_pdf_text(bytes: &[u8], page: Option<u32>) -> Result<String, String> {
    let guard = pdf_engine::pdfium_guard()?;
    let pdfium = &*guard;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| e.to_string())?;
    let page_count = document.pages().len() as u32;

    let mut out = String::new();
    let range: Vec<u32> = match page {
        Some(p) => {
            if p == 0 || p > page_count {
                return Err(format!(
                    "Page {p} out of range (document has {page_count} pages)."
                ));
            }
            vec![p - 1]
        }
        None => (0..page_count).collect(),
    };

    for index in range {
        let page = document
            .pages()
            .get(index as i32)
            .map_err(|e| e.to_string())?;
        let text = page.text().map_err(|e| e.to_string())?.all();
        if page_count > 1 {
            out.push_str(&format!("--- Page {} ---\n", index + 1));
        }
        out.push_str(text.trim());
        out.push('\n');
    }

    // Garde-fou : un document énorme ne doit pas saturer le contexte du client.
    const MAX_LEN: usize = 200_000;
    if out.len() > MAX_LEN {
        out.truncate(MAX_LEN);
        out.push_str("\n[... truncated ...]");
    }
    Ok(out)
}
