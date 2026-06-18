#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Empreinte du frontend générée par build.rs. L'inclure ici force `rustc` à recompiler
// `main.rs` (et donc `generate_context!()` à ré-embarquer le frontend) dès qu'un fichier
// de `frontend-dist` change. Sans ça, les changements de frontend passaient inaperçus.
const _FRONTEND_FINGERPRINT: &str =
    include_str!(concat!(env!("OUT_DIR"), "/frontend_fingerprint.txt"));

use sofdocs_desktop::{
    llm, ocr, pdf_compress, pdf_engine, pdf_forms, pdf_ops, pdf_sign, pdf_tools, system_fonts,
};

// Module local au binaire (pas dans la lib partagée) : l'auto-update n'est utile
// qu'à l'app Tauri, pas au sidecar `alto-mcp`.
mod updater;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager, State,
};

#[derive(Serialize, Clone)]
struct FileResult {
    path: String,
    file_name: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct PendingOpens(Mutex<Vec<FileResult>>);

/// Cache des octets de document, indexé par un id stable (empreinte du PDF).
/// Évite de resérialiser tout le fichier en JSON à CHAQUE appel `analyze_pdf_page`
/// (un scan par page/entrée en mode édition). On l'envoie une seule fois par doc.
#[derive(Default)]
struct DocCache(Mutex<std::collections::HashMap<String, Vec<u8>>>);

fn read_pdf_as_file_result(path: &Path) -> Option<FileResult> {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !ext_ok {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    Some(FileResult {
        path: path.to_string_lossy().to_string(),
        file_name,
        bytes,
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn dispatch_open_path(app: &tauri::AppHandle, path: &Path) {
    let Some(result) = read_pdf_as_file_result(path) else {
        return;
    };
    if let Some(state) = app.try_state::<PendingOpens>() {
        if let Ok(mut buf) = state.0.lock() {
            buf.push(result);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("alto-open-files-available", ());
        bring_window_to_front(&window);
    }
}

fn bring_window_to_front(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[tauri::command]
fn take_pending_open_files(state: State<'_, PendingOpens>) -> Vec<FileResult> {
    match state.0.lock() {
        Ok(mut buf) => std::mem::take(&mut *buf),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
async fn analyze_pdf_page(bytes: Vec<u8>, page: u32) -> Result<pdf_engine::PdfAnalysis, String> {
    pdf_engine::analyze_pdf_page(&bytes, page)
}

/// Met en cache les octets d'un document (envoyés une seule fois à l'ouverture/
/// premier scan). Borne mémoire : on purge si trop d'entrées s'accumulent.
#[tauri::command]
fn cache_document(state: State<'_, DocCache>, id: String, bytes: Vec<u8>) {
    if let Ok(mut map) = state.0.lock() {
        if map.len() >= 8 {
            map.clear();
        }
        map.insert(id, bytes);
    }
}

/// Analyse une page à partir des octets DÉJÀ en cache (par id). Renvoie une erreur
/// `cache_miss` si le document n'a pas encore été mis en cache : le frontend
/// rappelle alors `cache_document` une fois puis réessaie.
#[tauri::command]
async fn analyze_pdf_page_cached(
    state: State<'_, DocCache>,
    id: String,
    page: u32,
) -> Result<pdf_engine::PdfAnalysis, String> {
    let bytes = {
        let map = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
        map.get(&id).cloned()
    };
    let Some(bytes) = bytes else {
        return Err("cache_miss".to_string());
    };
    pdf_engine::analyze_pdf_page(&bytes, page)
}

#[tauri::command]
fn alto_debug(line: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/alto_debug.log")
    {
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
async fn ocr_page(
    image_bytes: Vec<u8>,
    language: Option<String>,
) -> Result<Vec<ocr::OcrBlock>, String> {
    ocr::recognize_png(&image_bytes, language)
}

#[tauri::command]
async fn ocr_pdf_page(
    bytes: Vec<u8>,
    page: u32,
    language: Option<String>,
) -> Result<ocr::OcrPageResult, String> {
    ocr::recognize_pdf_page(&bytes, page, language)
}

#[tauri::command]
async fn export_edited_pdf(
    pages: Vec<pdf_engine::FlattenedPage>,
) -> Result<tauri::ipc::Response, String> {
    pdf_engine::export_flattened_pdf(pages).map(tauri::ipc::Response::new)
}

/// Liste les familles de polices installées sur la machine, pour le sélecteur
/// de police de l'éditeur. Énumération potentiellement coûteuse → exécutée hors
/// du thread principal.
#[tauri::command]
async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(system_fonts::list_system_fonts)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn merge_pdfs(sources: Vec<Vec<u8>>) -> Result<tauri::ipc::Response, String> {
    pdf_ops::merge_pdfs(sources).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn encrypt_pdf(
    bytes: Vec<u8>,
    user_password: String,
    owner_password: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    pdf_ops::encrypt_pdf(bytes, user_password, owner_password).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn compress_pdf(
    bytes: Vec<u8>,
    level: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let level = level.unwrap_or_else(|| "medium".to_string());
    pdf_compress::compress_pdf_images(bytes, &level).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn repair_pdf(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    pdf_engine::repair_pdf(&bytes).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn remove_annotations(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    pdf_ops::remove_annotations(bytes).map(tauri::ipc::Response::new)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveBlankResult {
    bytes: Vec<u8>,
    removed: Vec<u32>,
}

#[tauri::command]
async fn remove_blank_pages(bytes: Vec<u8>) -> Result<RemoveBlankResult, String> {
    let (bytes, removed) = pdf_engine::remove_blank_pages(&bytes)?;
    Ok(RemoveBlankResult { bytes, removed })
}

#[tauri::command]
async fn deskew_pdf(bytes: Vec<u8>) -> Result<ocr::DeskewResult, String> {
    ocr::deskew_pdf(&bytes)
}

#[tauri::command]
async fn ocr_searchable_pdf(
    bytes: Vec<u8>,
    language: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let (out, _count) = ocr::ocr_searchable_pdf(&bytes, language)?;
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn sign_pdf_pades(
    bytes: Vec<u8>,
    p12_path: String,
    password: String,
    reason: Option<String>,
    location: Option<String>,
    contact: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    pdf_sign::sign_pdf_pades(&bytes, &p12_path, &password, reason, location, contact)
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn watermark_pdf(
    bytes: Vec<u8>,
    text: String,
    font_size: f64,
    opacity: f64,
    rotation: f64,
    color: Option<[u8; 3]>,
    bold: bool,
) -> Result<tauri::ipc::Response, String> {
    pdf_tools::watermark_text(&bytes, &text, font_size, opacity, rotation, color, bold)
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn add_page_numbers(
    bytes: Vec<u8>,
    position: String,
    start_at: i64,
    font_size: f64,
    margin: f64,
) -> Result<tauri::ipc::Response, String> {
    pdf_tools::add_page_numbers(&bytes, &position, start_at, font_size, margin)
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn images_to_pdf(images: Vec<Vec<u8>>) -> Result<tauri::ipc::Response, String> {
    pdf_tools::images_to_pdf(images).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn remove_password(bytes: Vec<u8>, password: String) -> Result<tauri::ipc::Response, String> {
    pdf_tools::remove_password(&bytes, &password).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn crop_pdf(
    bytes: Vec<u8>,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> Result<tauri::ipc::Response, String> {
    pdf_tools::crop_pages(&bytes, left, top, right, bottom).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn flatten_pdf(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    pdf_tools::flatten(&bytes).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn extract_images(bytes: Vec<u8>) -> Result<Vec<pdf_tools::ExtractedImage>, String> {
    pdf_tools::extract_images(&bytes)
}

#[tauri::command]
async fn list_form_fields(bytes: Vec<u8>) -> Result<Vec<pdf_forms::FormField>, String> {
    pdf_forms::list_form_fields(&bytes)
}

#[tauri::command]
async fn fill_form_fields(
    bytes: Vec<u8>,
    values: std::collections::HashMap<String, String>,
) -> Result<tauri::ipc::Response, String> {
    pdf_forms::fill_form_fields(&bytes, values).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn auto_redact(
    bytes: Vec<u8>,
    terms: Vec<String>,
    match_case: bool,
) -> Result<AutoRedactResult, String> {
    let (out, count) = pdf_tools::auto_redact(&bytes, &terms, match_case)?;
    Ok(AutoRedactResult { bytes: out, count })
}

#[derive(serde::Serialize)]
struct AutoRedactResult {
    bytes: Vec<u8>,
    count: usize,
}

#[tauri::command]
async fn sanitize_pdf(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    pdf_tools::sanitize(&bytes).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn get_bookmarks(bytes: Vec<u8>) -> Result<Vec<pdf_tools::BookmarkItem>, String> {
    pdf_tools::get_bookmarks(&bytes)
}

#[tauri::command]
async fn set_bookmarks(
    bytes: Vec<u8>,
    items: Vec<pdf_tools::BookmarkItem>,
) -> Result<tauri::ipc::Response, String> {
    pdf_tools::set_bookmarks(&bytes, &items).map(tauri::ipc::Response::new)
}

/// Chemin du serveur MCP embarqué, pour configuration manuelle d'autres
/// clients (ChatGPT Desktop, Cursor...).
#[tauri::command]
fn mcp_binary_path() -> Result<String, String> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("alto-mcp")))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Binaire alto-mcp introuvable à côté de l'application.".to_string())
}

/// Inscrit le serveur MCP `alto-mcp` dans la configuration de Claude Desktop
/// (~/Library/Application Support/Claude/claude_desktop_config.json).
#[tauri::command]
fn connect_claude_desktop() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Dossier utilisateur introuvable.")?;
    let config_dir = home.join("Library/Application Support/Claude");
    if !config_dir.exists() {
        return Err(
            "Claude Desktop n'est pas installé sur ce Mac (dossier de configuration introuvable)."
                .to_string(),
        );
    }

    let mcp_path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("alto-mcp")))
        .filter(|path| path.exists())
        .ok_or("Binaire alto-mcp introuvable à côté de l'application.")?;

    let config_path = config_dir.join("claude_desktop_config.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let raw = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !config.is_object() {
        config = serde_json::json!({});
    }

    let config_obj = config
        .as_object_mut()
        .ok_or("Configuration Claude invalide.")?;
    let servers = config_obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    if let Some(servers_obj) = servers.as_object_mut() {
        servers_obj.insert(
            "alto-pdf".to_string(),
            serde_json::json!({ "command": mcp_path.to_string_lossy() }),
        );
    }

    let serialized = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, serialized).map_err(|e| e.to_string())?;
    Ok(mcp_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn rotate_pages(
    bytes: Vec<u8>,
    page_numbers: Vec<u32>,
    angle: i32,
) -> Result<tauri::ipc::Response, String> {
    pdf_ops::rotate_pages(bytes, page_numbers, angle).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn delete_pages(
    bytes: Vec<u8>,
    page_numbers: Vec<u32>,
) -> Result<tauri::ipc::Response, String> {
    pdf_ops::delete_pages(bytes, page_numbers).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn extract_pages(
    bytes: Vec<u8>,
    page_numbers: Vec<u32>,
) -> Result<tauri::ipc::Response, String> {
    pdf_ops::extract_pages(bytes, page_numbers).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn reorder_pages(bytes: Vec<u8>, new_order: Vec<u32>) -> Result<tauri::ipc::Response, String> {
    pdf_ops::reorder_pages(bytes, new_order).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn document_properties(bytes: Vec<u8>) -> Result<pdf_ops::PdfProperties, String> {
    pdf_ops::document_properties(bytes)
}

#[tauri::command]
async fn read_pdf_path(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_default_pdf_handler() -> Result<(), String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
    let content_type = CFString::new("com.adobe.pdf");
    let bundle_id = CFString::new("com.soflution.slate");

    let status = unsafe {
        LSSetDefaultRoleHandlerForContentType(
            content_type.as_concrete_TypeRef(),
            K_LS_ROLES_ALL,
            bundle_id.as_concrete_TypeRef(),
        )
    };

    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "Impossible de définir Slate par défaut (code {status})."
        ))
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_default_pdf_handler() -> Result<(), String> {
    Err("Disponible uniquement sur macOS pour le moment.".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn is_default_pdf_handler() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
        ) -> CFStringRef;
    }

    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
    let content_type = CFString::new("com.adobe.pdf");

    let handler_ref = unsafe {
        LSCopyDefaultRoleHandlerForContentType(content_type.as_concrete_TypeRef(), K_LS_ROLES_ALL)
    };

    if handler_ref.is_null() {
        return false;
    }

    let handler = unsafe { CFString::wrap_under_create_rule(handler_ref) };
    handler
        .to_string()
        .eq_ignore_ascii_case("com.soflution.slate")
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn is_default_pdf_handler() -> bool {
    false
}

#[tauri::command]
async fn pick_multiple_pdfs(app: tauri::AppHandle) -> Result<Vec<FileResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    let files = app
        .dialog()
        .file()
        .add_filter("PDF Documents", &["pdf"])
        .blocking_pick_files();

    let mut out = Vec::new();
    if let Some(paths) = files {
        for fp in paths {
            let path_str = fp.to_string();
            let file_name = Path::new(&path_str)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("document.pdf")
                .to_string();
            let bytes = std::fs::read(&path_str).map_err(|e| e.to_string())?;
            out.push(FileResult {
                path: path_str,
                file_name,
                bytes,
            });
        }
    }
    Ok(out)
}

/// Sélectionne un certificat PKCS#12 (.p12/.pfx) et renvoie son chemin.
#[tauri::command]
async fn pick_certificate_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file = app
        .dialog()
        .file()
        .add_filter("Certificates (.p12, .pfx)", &["p12", "pfx"])
        .blocking_pick_file();

    Ok(file.map(|fp| fp.to_string()))
}

/// Imprime un PDF via le dialogue d'impression natif du système.
/// `window.print()` est inopérant dans le WebView macOS (WKWebView), on passe
/// donc par un fichier temporaire + l'imprimante du système.
#[tauri::command]
async fn print_pdf(bytes: Vec<u8>) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Le contenu à imprimer n'est pas un PDF valide.".into());
    }

    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    path.push(format!("alto-impression-{stamp}.pdf"));
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Écriture du fichier d'impression impossible : {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        // Aperçu affiche le dialogue d'impression standard (choix imprimante,
        // copies, recto-verso...) grâce au paramètre « with print dialog ».
        let script = format!(
            "tell application \"Preview\"\nactivate\nprint POSIX file \"{}\" with print dialog\nend tell",
            path_str.replace('\\', "\\\\").replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Lancement de l'impression impossible : {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "/min", &path_str])
            .spawn()
            .map_err(|e| format!("Lancement de l'impression impossible : {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("lp")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("Lancement de l'impression impossible : {e}"))?;
    }

    Ok(())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("URL invalide".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Sélectionne une ou plusieurs images (PNG/JPEG) et renvoie leurs octets,
/// pour la fonction « Images → PDF ».
#[tauri::command]
async fn pick_images(app: tauri::AppHandle) -> Result<Vec<Vec<u8>>, String> {
    use tauri_plugin_dialog::DialogExt;

    let files = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg"])
        .blocking_pick_files();

    let mut out = Vec::new();
    if let Some(paths) = files {
        for fp in paths {
            let path_str = fp.to_string();
            let bytes = std::fs::read(&path_str).map_err(|e| e.to_string())?;
            out.push(bytes);
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
struct ExtractImagesReport {
    folder: String,
    count: usize,
}

/// Extrait toutes les images d'un PDF et les écrit (PNG) dans un dossier choisi.
#[tauri::command]
async fn extract_images_to_folder(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
) -> Result<Option<ExtractImagesReport>, String> {
    use tauri_plugin_dialog::DialogExt;

    let images = pdf_tools::extract_images(&bytes)?;

    let folder = app.dialog().file().blocking_pick_folder();
    let Some(folder) = folder else {
        return Ok(None);
    };
    let folder_path = std::path::PathBuf::from(folder.to_string());

    for image in &images {
        let name = format!("image-p{}-{}.png", image.page, image.index);
        std::fs::write(folder_path.join(&name), &image.png)
            .map_err(|e| format!("Écriture de {name} impossible : {e}"))?;
    }
    Ok(Some(ExtractImagesReport {
        folder: folder_path.to_string_lossy().to_string(),
        count: images.len(),
    }))
}

#[tauri::command]
async fn create_blank_pdf() -> Result<tauri::ipc::Response, String> {
    let header = b"%PDF-1.4\n";
    let obj1 = b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n";
    let obj2 = b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n";
    let obj3 = b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>/Contents 4 0 R>>\nendobj\n";
    let obj4 = b"4 0 obj\n<</Length 0>>\nstream\n\nendstream\nendobj\n";

    let off1 = header.len();
    let off2 = off1 + obj1.len();
    let off3 = off2 + obj2.len();
    let off4 = off3 + obj3.len();
    let xref_offset = off4 + obj4.len();

    let xref = format!(
        "xref\n0 5\n0000000000 65535 f \n{:010} 00000 n \n{:010} 00000 n \n{:010} 00000 n \n{:010} 00000 n \ntrailer\n<</Size 5/Root 1 0 R>>\nstartxref\n{}\n%%EOF\n",
        off1, off2, off3, off4, xref_offset
    );

    let mut out = Vec::with_capacity(xref_offset + xref.len());
    out.extend_from_slice(header);
    out.extend_from_slice(obj1);
    out.extend_from_slice(obj2);
    out.extend_from_slice(obj3);
    out.extend_from_slice(obj4);
    out.extend_from_slice(xref.as_bytes());
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn open_file(app: tauri::AppHandle) -> Result<Option<FileResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("PDF Documents", &["pdf"])
        .blocking_pick_file();

    match file_path {
        Some(fp) => {
            let path_str = fp.to_string();
            let file_name = Path::new(&path_str)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("document.pdf")
                .to_string();
            let bytes = std::fs::read(&path_str).map_err(|e| e.to_string())?;
            Ok(Some(FileResult {
                path: path_str,
                file_name,
                bytes,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn save_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_file_dialog(
    app: tauri::AppHandle,
    data: Vec<u8>,
    filename: String,
    extension: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let extension = extension.trim_start_matches('.').to_string();
    let filter_name = match extension.as_str() {
        "pdf" => "PDF Documents",
        "json" => "JSON Files",
        _ => "Files",
    };

    let mut dialog = app
        .dialog()
        .file()
        .add_filter(filter_name, &[extension.as_str()])
        .set_file_name(filename);

    if let Some(documents_dir) = dirs::document_dir() {
        dialog = dialog.set_directory(documents_dir);
    }

    let file_path = dialog.blocking_save_file();

    match file_path {
        Some(fp) => {
            let path_str = fp.to_string();
            std::fs::write(&path_str, &data).map_err(|e| e.to_string())?;
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}

fn main() {
    // Le moteur PDF vit désormais dans le crate `alto-pdf-engine` : son
    // `CARGO_MANIFEST_DIR` ne pointe plus vers `src-tauri`. En dev/CI la dylib
    // PDFium est à la racine de `src-tauri`, on l'expose donc explicitement comme
    // dossier de recherche (ignoré en prod : c'est le dossier de l'exécutable qui prime).
    if std::env::var_os("ALTO_PDFIUM_DIR").is_none() {
        std::env::set_var("ALTO_PDFIUM_DIR", env!("CARGO_MANIFEST_DIR"));
    }

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init()
        .ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingOpens::default())
        .manage(DocCache::default())
        .setup(|app| {
            // Pré-chauffe PDFium en arrière-plan : charge/initialise la lib native
            // dès le démarrage pour supprimer la latence du premier appel PDF.
            std::thread::spawn(|| {
                if let Ok(guard) = pdf_engine::pdfium_guard() {
                    drop(guard);
                }
            });

            let pending = app.state::<PendingOpens>();
            if let Ok(mut buf) = pending.0.lock() {
                for arg in std::env::args().skip(1) {
                    if arg.starts_with('-') {
                        continue;
                    }
                    let candidate = Path::new(&arg);
                    if let Some(result) = read_pdf_as_file_result(candidate) {
                        buf.push(result);
                    }
                }
            }

            let about = MenuItemBuilder::new("À propos de Slate")
                .id("about")
                .build(app)?;
            let plugins = MenuItemBuilder::new("À propos des modules externes Slate...")
                .id("about-plugins")
                .build(app)?;
            let settings = MenuItemBuilder::new("Préférences...")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let accessibility =
                MenuItemBuilder::new("Assistant de configuration d’accessibilité...")
                    .id("accessibility-setup")
                    .build(app)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let services = SubmenuBuilder::new(app, "Services")
                .text("unsupported-services", "Aucun service disponible")
                .build()?;
            let hide = PredefinedMenuItem::hide(app, Some("Masquer Slate"))?;
            let hide_others = PredefinedMenuItem::hide_others(app, Some("Masquer les autres"))?;
            let show_all = PredefinedMenuItem::show_all(app, Some("Afficher tout"))?;
            let quit = PredefinedMenuItem::quit(app, Some("Quitter Slate"))?;
            let app_menu = SubmenuBuilder::new(app, "Slate")
                .item(&about)
                .item(&plugins)
                .item(&separator)
                .item(&settings)
                .item(&accessibility)
                .item(&separator)
                .item(&services)
                .item(&separator)
                .item(&hide)
                .item(&hide_others)
                .item(&show_all)
                .item(&separator)
                .item(&quit)
                .build()?;

            let recent_menu = SubmenuBuilder::new(app, "Ouvrir les fichiers récents")
                .text("recent-files", "Tous les fichiers récents...")
                .build()?;
            let create_menu = SubmenuBuilder::new(app, "Créer")
                .text("unsupported-create-pdf", "Créer un PDF")
                .text("unsupported-create-blank", "Créer une page vierge")
                .build()?;
            let save_as_other_menu = SubmenuBuilder::new(app, "Enregistrer sous un autre")
                .text("export-edited-pdf", "PDF modifié")
                .text("export-notes", "Notes JSON")
                .build()?;
            let export_menu = SubmenuBuilder::new(app, "Exporter un PDF")
                .text("export-edited-pdf", "PDF modifié...")
                .text("unsupported-export-word", "Microsoft Word")
                .text("unsupported-export-image", "Image")
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "Fichier")
                .text("open-pdf", "Ouvrir...")
                .item(&recent_menu)
                .item(&create_menu)
                .text("combine-files", "Combiner les fichiers")
                .separator()
                .text("save-copy", "Enregistrer")
                .text("save-as", "Enregistrer sous...")
                .item(&save_as_other_menu)
                .text("compress-pdf", "Compresser un fichier PDF")
                .item(&export_menu)
                .text("protect-pdf", "Protéger à l’aide d’un mot de passe")
                .separator()
                .text(
                    "unsupported-signatures",
                    "Demander des signatures électroniques",
                )
                .text("unsupported-share", "Partager le fichier")
                .separator()
                .text("print", "Imprimer...")
                .text("focus-search", "Rechercher")
                .text("unsupported-advanced-search", "Recherche avancée")
                .separator()
                .text("document-properties", "Propriétés du document...")
                .separator()
                .text("close-file", "Fermer le fichier")
                .build()?;

            let undo_item = MenuItemBuilder::new("Annuler  ⌘Z").id("undo").build(app)?;
            let redo_item = MenuItemBuilder::new("Rétablir  ⌘Y").id("redo").build(app)?;
            let undo_menu = SubmenuBuilder::new(app, "Annuler, rétablir et plus encore")
                .item(&undo_item)
                .item(&redo_item)
                .build()?;
            let add_image_menu = SubmenuBuilder::new(app, "Ajouter une image")
                .text("unsupported-add-image-file", "Depuis un fichier...")
                .build()?;
            let protection_menu = SubmenuBuilder::new(app, "Protection")
                .text("protect-pdf", "Ajouter un mot de passe")
                .text("unsupported-redact", "Biffer un PDF")
                .build()?;
            let cut_item = PredefinedMenuItem::cut(app, Some("Couper"))?;
            let copy_item = PredefinedMenuItem::copy(app, Some("Copier"))?;
            let paste_item = PredefinedMenuItem::paste(app, Some("Coller"))?;
            let select_all_item = PredefinedMenuItem::select_all(app, Some("Tout sélectionner"))?;
            let edit_menu = SubmenuBuilder::new(app, "Édition")
                .item(&cut_item)
                .item(&copy_item)
                .item(&paste_item)
                .item(&select_all_item)
                .item(&undo_menu)
                .separator()
                .text("modify-pdf", "Modifier le PDF")
                .text("unsupported-add-text", "Ajouter du texte")
                .item(&add_image_menu)
                .separator()
                .text("delete-page", "Supprimer la page")
                .text("rotate-page-cw", "Faire pivoter la page (horaire)")
                .text("rotate-page-ccw", "Faire pivoter la page (antihoraire)")
                .text("organize-pages", "Organiser les pages")
                .separator()
                .text("unsupported-redact", "Biffer un PDF")
                .text("ocr-page", "Scan et OCR")
                .text("unsupported-form", "Préparer le formulaire")
                .item(&protection_menu)
                .separator()
                .text("unsupported-special-chars", "Caractères spéciaux...")
                .build()?;

            let rotate_view_menu = SubmenuBuilder::new(app, "Faire pivoter la vue")
                .text("unsupported-rotate-clockwise", "Horaire")
                .text("unsupported-rotate-counter", "Antihoraire")
                .build()?;
            let page_navigation_menu = SubmenuBuilder::new(app, "Navigation de pages")
                .text("prev-page", "Page précédente")
                .text("next-page", "Page suivante")
                .build()?;
            let display_menu = SubmenuBuilder::new(app, "Affichage")
                .text("toggle-tools", "Tous les outils")
                .text("unsupported-sidebar", "Panneaux latéraux")
                .build()?;
            let zoom_menu = SubmenuBuilder::new(app, "Zoom")
                .text("fit-width", "Largeur page")
                .text("zoom-in", "Zoom avant")
                .text("zoom-out", "Zoom arrière")
                .build()?;
            let show_hide_menu = SubmenuBuilder::new(app, "Afficher/Masquer")
                .text("toggle-tools", "Tous les outils")
                .text("unsupported-right-rail", "Barre d’outils droite")
                .build()?;
            let theme_menu = SubmenuBuilder::new(app, "Thème d’affichage")
                .text("unsupported-theme-system", "Système")
                .text("unsupported-theme-light", "Clair")
                .build()?;
            let audio_menu = SubmenuBuilder::new(app, "Lecture audio")
                .text("unsupported-read-aloud", "Lire à voix haute")
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "Affichage")
                .item(&rotate_view_menu)
                .item(&page_navigation_menu)
                .item(&display_menu)
                .item(&zoom_menu)
                .separator()
                .text("unsupported-reading-mode", "Mode Lecture")
                .text("unsupported-fullscreen", "Mode plein écran")
                .separator()
                .item(&show_hide_menu)
                .item(&theme_menu)
                .text(
                    "unsupported-disable-new-acrobat",
                    "Désactiver la nouvelle version d’Acrobat",
                )
                .separator()
                .item(&audio_menu)
                .text("unsupported-tracking-device", "Dispositif de suivi...")
                .build()?;

            let move_resize_menu = SubmenuBuilder::new(app, "Déplacer et redimensionner")
                .text("unsupported-resize-left", "Vers la gauche")
                .text("unsupported-resize-right", "Vers la droite")
                .build()?;
            let tile_menu = SubmenuBuilder::new(app, "Mosaïque")
                .text("unsupported-tile-horizontal", "Horizontale")
                .text("unsupported-tile-vertical", "Verticale")
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Fenêtre")
                .text("unsupported-fill", "Remplir")
                .text("unsupported-center", "Centrer")
                .item(&move_resize_menu)
                .separator()
                .text(
                    "unsupported-move-display-1",
                    "Déplacer vers l’écran principal",
                )
                .text("new-window", "Nouvelle fenêtre")
                .separator()
                .text("unsupported-cascade", "Cascade")
                .item(&tile_menu)
                .text("unsupported-minimize", "Réduire")
                .separator()
                .text("window-current-file", "Document Slate")
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Aide")
                .text("focus-search", "Rechercher")
                .text("unsupported-ai-help", "Comment utiliser l’Assistant IA")
                .separator()
                .text("modify-pdf", "Aide “Modifier un PDF”")
                .text("unsupported-help", "Aide Slate")
                .text("unsupported-tutorials", "Tutoriels Slate")
                .separator()
                .text("settings", "Gérer mon compte...")
                .text("unsupported-updates", "Rechercher les mises à jour")
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &window_menu,
                    &help_menu,
                ])
                .build()?;

            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let event_name = match event.id().as_ref() {
                "settings" => Some("alto-open-settings"),
                "open-pdf" => Some("alto-open-pdf"),
                "export-notes" => Some("alto-export-notes"),
                "export-edited-pdf" => Some("alto-export-edited-pdf"),
                "save-copy" => Some("alto-save-copy"),
                "save-as" => Some("alto-save-as"),
                "modify-pdf" => Some("alto-modify-pdf"),
                "focus-search" => Some("alto-focus-search"),
                "ocr-page" => Some("alto-ocr-page"),
                "toggle-tools" => Some("alto-toggle-tools"),
                "print" => Some("alto-print"),
                "prev-page" => Some("alto-prev-page"),
                "next-page" => Some("alto-next-page"),
                "close-file" => Some("alto-close-file"),
                "fit-width" => Some("alto-fit-width"),
                "zoom-in" => Some("alto-zoom-in"),
                "zoom-out" => Some("alto-zoom-out"),
                "undo" => Some("alto-undo"),
                "redo" => Some("alto-redo"),
                "document-properties" => Some("alto-document-properties"),
                "recent-files" => Some("alto-recent-files"),
                "combine-files" => Some("alto-combine-files"),
                "compress-pdf" => Some("alto-compress-pdf"),
                "protect-pdf" => Some("alto-protect-pdf"),
                "delete-page" => Some("alto-delete-page"),
                "rotate-page-cw" => Some("alto-rotate-page-cw"),
                "rotate-page-ccw" => Some("alto-rotate-page-ccw"),
                "organize-pages" => Some("alto-organize-pages"),
                id if id.starts_with("unsupported")
                    || id == "about"
                    || id == "about-plugins"
                    || id == "new-window"
                    || id == "window-current-file" =>
                {
                    Some("alto-menu-unsupported")
                }
                _ => None,
            };

            if let Some(event_name) = event_name {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(event_name, ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            analyze_pdf_page,
            cache_document,
            analyze_pdf_page_cached,
            alto_debug,
            ocr_page,
            ocr_pdf_page,
            export_edited_pdf,
            list_system_fonts,
            create_blank_pdf,
            open_file,
            save_file,
            save_file_dialog,
            take_pending_open_files,
            merge_pdfs,
            encrypt_pdf,
            compress_pdf,
            repair_pdf,
            remove_annotations,
            remove_blank_pages,
            deskew_pdf,
            ocr_searchable_pdf,
            sign_pdf_pades,
            pick_certificate_file,
            connect_claude_desktop,
            mcp_binary_path,
            rotate_pages,
            delete_pages,
            extract_pages,
            reorder_pages,
            document_properties,
            read_pdf_path,
            set_default_pdf_handler,
            is_default_pdf_handler,
            pick_multiple_pdfs,
            open_external,
            print_pdf,
            watermark_pdf,
            add_page_numbers,
            images_to_pdf,
            remove_password,
            crop_pdf,
            flatten_pdf,
            extract_images,
            list_form_fields,
            fill_form_fields,
            extract_images_to_folder,
            pick_images,
            auto_redact,
            sanitize_pdf,
            get_bookmarks,
            set_bookmarks,
            llm::llm_get_config,
            llm::llm_set_config,
            llm::llm_chat,
            updater::check_for_update,
            updater::install_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building Alto desktop")
        .run(|_app, _event| {
            // RunEvent::Opened n'existe que sur macOS/iOS (ouverture via Finder /
            // association de fichiers). Sur Windows/Linux, l'ouverture passe par les
            // arguments CLI, gérés ailleurs.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        dispatch_open_path(_app, &path);
                    }
                }
            }
        });
}
