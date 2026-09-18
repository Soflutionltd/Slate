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
    llm, ocr, pdf_compress, pdf_edit, pdf_engine, pdf_forms, pdf_ops, pdf_sign, pdf_tools,
    system_fonts,
};

// Module local au binaire (pas dans la lib partagée) : l'auto-update n'est utile
// qu'à l'app Tauri, pas au sidecar `alto-mcp`.
mod updater;

// Impression depuis le Finder (Apple Event « print documents »). Spécifique macOS :
// Tauri ne forwarde QUE l'event « open », pas « print ». On installe donc notre
// propre méthode `application:printFiles:…` sur le delegate AppKit.
#[cfg(target_os = "macos")]
mod mac_print;

// Ouverture à chaud (Mail / Finder) quand `RunEvent::Opened` est droppé pour
// les fichiers en quarantaine — handler Apple Event `odoc` + openFile fallback.
#[cfg(target_os = "macos")]
mod mac_open;

mod pdf_color;
mod print_cups;
use sofdocs_desktop::print_layout;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[derive(Serialize, Clone)]
struct FileResult {
    path: String,
    file_name: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct PendingOpens(Mutex<Vec<FileResult>>);

/// PDF à imprimer dès l'ouverture (déclenchés par l'Apple Event « print » du Finder).
/// Le frontend les draine, ouvre chaque document puis lance l'impression.
#[derive(Default)]
struct PendingPrints(Mutex<Vec<FileResult>>);

/// Document arraché d'un onglet, à ouvrir dans la fenêtre `win-*` qui démarre.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetachedTab {
    file_name: String,
    file_path: Option<String>,
    bytes: Vec<u8>,
    #[serde(default)]
    annotations: serde_json::Value,
    #[serde(default)]
    edit_blocks: serde_json::Value,
    #[serde(default)]
    page: u32,
    #[serde(default)]
    dirty: bool,
}

#[derive(Default)]
struct PendingDetachedTabs(Mutex<std::collections::HashMap<String, DetachedTab>>);

/// Drag d'onglet en cours (tear-off, fusion vers une autre fenêtre, ou dépôt du
/// PDF comme fichier dans une app tierce).
struct LiveTabDrag {
    source_label: String,
    payload: DetachedTab,
    claimed_by: Option<String>,
    /// Renseigné quand la session de drag native est terminée. On garde alors
    /// l'entrée quelques secondes : le `drop` HTML de la fenêtre Slate visée
    /// arrive APRÈS la fin de session AppKit, et doit savoir que ce fichier
    /// déposé est notre onglet (déjà fusionné) et non un PDF à ouvrir.
    ended_at: Option<std::time::Instant>,
}

const TAB_DRAG_LINGER: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Default)]
struct ActiveTabDrag(Mutex<Option<LiveTabDrag>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabDragEnded {
    action: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeTabPayload {
    #[serde(flatten)]
    tab: DetachedTab,
    relative_x: f64,
}

fn detached_tab_from_parts(
    file_name: String,
    file_path: Option<String>,
    mut bytes: Vec<u8>,
    annotations: Option<serde_json::Value>,
    edit_blocks: Option<serde_json::Value>,
    page: Option<u32>,
    dirty: Option<bool>,
) -> Result<DetachedTab, String> {
    if bytes.is_empty() {
        if let Some(path) = file_path.as_deref().filter(|p| !p.is_empty()) {
            bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        }
    }
    if bytes.is_empty() {
        return Err("empty_document".into());
    }
    Ok(DetachedTab {
        file_name,
        file_path,
        bytes,
        annotations: annotations.unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
        edit_blocks: edit_blocks.unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
        page: page.unwrap_or(1),
        dirty: dirty.unwrap_or(false),
    })
}

/// Cache des octets de document, indexé par un id stable (empreinte du PDF).
/// Évite de resérialiser tout le fichier en JSON à CHAQUE appel `analyze_pdf_page`
/// (un scan par page/entrée en mode édition). On l'envoie une seule fois par doc.
#[derive(Default)]
struct DocCache(Mutex<std::collections::HashMap<String, Vec<u8>>>);

/// Flux de contenu D'ORIGINE des pages éditées nativement (chantier « undo par
/// versionnage ») : capturé à la PREMIÈRE édition de chaque page après le
/// primage du cache. Un undo restaure ce flux EXACTEMENT (le document redevient
/// octet-pour-octet ce qu'il était), puis le frontend rejoue le texte de l'UI
/// en une édition avant propre — plus d'« édition inverse » recalculée par
/// diff de texte, fragile quand l'analyse re-segmente les blocs.
#[derive(Default)]
struct DocBaselines(Mutex<std::collections::HashMap<String, std::collections::HashMap<u32, Vec<u8>>>>);

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

/// Empile un PDF à ouvrir (Finder / Mail / AEM odoc) et prévient le frontend.
/// Déduplique par chemin pour éviter un double onglet si `RunEvent::Opened` et
/// le handler Apple Event arrivent tous les deux.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn dispatch_open_path(app: &tauri::AppHandle, path: &Path) {
    let Some(result) = read_pdf_as_file_result(path) else {
        return;
    };
    let path_key = result.path.clone();
    let mut queued = false;
    if let Some(state) = app.try_state::<PendingOpens>() {
        if let Ok(mut buf) = state.0.lock() {
            if buf.iter().any(|f| f.path == path_key) {
                // Déjà en file (Opened + odoc simultanés).
            } else {
                buf.push(result);
                queued = true;
            }
        }
    }
    if !queued {
        // Même sans nouvel item : ramener la fenêtre focus (2ᵉ clic Mail).
        if let Some(window) = focused_webview(app) {
            bring_window_to_front(&window);
        }
        return;
    }
    if let Some(window) = focused_webview(app) {
        let _ = window.emit("alto-open-files-available", ());
        bring_window_to_front(&window);
    }
}

fn focused_webview(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next())
}

fn next_window_label() -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(1);
    format!("win-{stamp}")
}

fn spawn_slate_window(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1440.0, 920.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px - 48.0, py - 16.0);
    }
    builder.build().map_err(|e| e.to_string())
}

#[tauri::command]
fn spawn_document_window(
    app: tauri::AppHandle,
    pending: State<'_, PendingDetachedTabs>,
    file_name: String,
    file_path: Option<String>,
    bytes: Vec<u8>,
    annotations: Option<serde_json::Value>,
    edit_blocks: Option<serde_json::Value>,
    page: Option<u32>,
    dirty: Option<bool>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let doc = detached_tab_from_parts(
        file_name,
        file_path,
        bytes,
        annotations,
        edit_blocks,
        page,
        dirty,
    )?;
    spawn_detached_window(&app, &pending, doc, x, y)
}

fn spawn_detached_window(
    app: &tauri::AppHandle,
    pending: &PendingDetachedTabs,
    doc: DetachedTab,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let title = doc.file_name.clone();
    let label = next_window_label();
    if let Ok(mut map) = pending.0.lock() {
        map.insert(label.clone(), doc);
    }
    if let Err(err) = spawn_slate_window(app, &label, &title, x, y) {
        if let Ok(mut map) = pending.0.lock() {
            map.remove(&label);
        }
        return Err(err);
    }
    Ok(label)
}

#[tauri::command]
fn spawn_empty_window(app: tauri::AppHandle) -> Result<String, String> {
    let label = next_window_label();
    spawn_slate_window(&app, &label, "Slate", None, None)?;
    Ok(label)
}

#[tauri::command]
fn take_detached_tab(
    window: WebviewWindow,
    pending: State<'_, PendingDetachedTabs>,
) -> Option<DetachedTab> {
    pending.0.lock().ok()?.remove(window.label())
}

#[tauri::command]
fn begin_tab_drag(
    window: WebviewWindow,
    drag: State<'_, ActiveTabDrag>,
    file_name: String,
    file_path: Option<String>,
    bytes: Vec<u8>,
    annotations: Option<serde_json::Value>,
    edit_blocks: Option<serde_json::Value>,
    page: Option<u32>,
    dirty: Option<bool>,
) -> Result<(), String> {
    let payload = detached_tab_from_parts(
        file_name,
        file_path,
        bytes,
        annotations,
        edit_blocks,
        page,
        dirty,
    )?;
    let mut slot = drag.0.lock().map_err(|e| e.to_string())?;
    *slot = Some(LiveTabDrag {
        source_label: window.label().to_string(),
        payload,
        claimed_by: None,
        ended_at: None,
    });
    Ok(())
}

/// Le geste s'est terminé dans la barre (simple réordonnancement) ou a été
/// abandonné avant le drag natif : on libère l'onglet préparé.
#[tauri::command]
fn cancel_tab_drag(window: WebviewWindow, drag: State<'_, ActiveTabDrag>) {
    if let Ok(mut slot) = drag.0.lock() {
        let owned = slot
            .as_ref()
            .map(|active| active.source_label == window.label() && active.ended_at.is_none())
            .unwrap_or(false);
        if owned {
            *slot = None;
        }
    }
}

/// Vrai pendant un drag d'onglet et quelques secondes après sa fin : le `drop`
/// HTML qui reçoit le fichier temporaire doit l'ignorer (ce n'est pas un PDF
/// que l'utilisateur ouvre, c'est l'onglet lui-même).
#[tauri::command]
fn is_tab_drag_active(drag: State<'_, ActiveTabDrag>) -> bool {
    let Ok(slot) = drag.0.lock() else {
        return false;
    };
    match slot.as_ref() {
        Some(active) => active
            .ended_at
            .map(|ended| ended.elapsed() < TAB_DRAG_LINGER)
            .unwrap_or(true),
        None => false,
    }
}

#[tauri::command]
fn claim_tab_drag(
    window: WebviewWindow,
    drag: State<'_, ActiveTabDrag>,
) -> Option<DetachedTab> {
    let mut slot = drag.0.lock().ok()?;
    let active = slot.as_mut()?;
    if active.source_label == window.label()
        || active.claimed_by.is_some()
        || active.ended_at.is_some()
    {
        return None;
    }
    active.claimed_by = Some(window.label().to_string());
    Some(active.payload.clone())
}

fn tab_drag_temp_root() -> std::path::PathBuf {
    std::env::temp_dir().join("slate-tab-drag")
}

fn sanitize_drag_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim();
    let base = if trimmed.is_empty() { "document.pdf" } else { trimmed };
    if base.to_ascii_lowercase().ends_with(".pdf") {
        base.to_string()
    } else {
        format!("{base}.pdf")
    }
}

/// Démarre le drag natif (AppKit/OLE) de l'onglet en cours : le PDF est glissé
/// comme un vrai fichier. Un document propre déjà sur disque est glissé tel
/// quel ; sinon on écrit une copie (export des éditions si fourni) dans un
/// dossier temporaire. Commande synchrone : Tauri l'exécute sur le main thread,
/// condition requise par `beginDraggingSessionWithItems:`.
#[tauri::command]
fn start_tab_native_drag(
    window: WebviewWindow,
    app: tauri::AppHandle,
    drag: State<'_, ActiveTabDrag>,
    icon: Vec<u8>,
    export_bytes: Option<Vec<u8>>,
) -> Result<(), String> {
    let (source_label, path) = {
        let slot = drag.0.lock().map_err(|e| e.to_string())?;
        let active = slot
            .as_ref()
            .filter(|active| active.source_label == window.label() && active.ended_at.is_none())
            .ok_or_else(|| "no_active_tab_drag".to_string())?;
        let on_disk = active
            .payload
            .file_path
            .as_deref()
            .filter(|_| !active.payload.dirty && export_bytes.is_none())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_file());
        let path = match on_disk {
            Some(path) => path,
            None => {
                let root = tab_drag_temp_root();
                let _ = std::fs::remove_dir_all(&root);
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(1);
                let dir = root.join(stamp.to_string());
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let path = dir.join(sanitize_drag_file_name(&active.payload.file_name));
                let bytes = export_bytes.as_deref().unwrap_or(&active.payload.bytes);
                std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
                path
            }
        };
        (active.source_label.clone(), path)
    };
    if icon.is_empty() {
        return Err("missing_drag_icon".into());
    }
    start_native_file_drag(&window, path, icon, move |dropped| {
        finish_native_tab_drag(&app, &source_label, dropped);
    })
}

#[cfg(not(target_os = "linux"))]
fn start_native_file_drag<F: Fn(bool) + Send + 'static>(
    window: &WebviewWindow,
    path: std::path::PathBuf,
    icon: Vec<u8>,
    on_end: F,
) -> Result<(), String> {
    drag::start_drag(
        window,
        drag::DragItem::Files(vec![path]),
        drag::Image::Raw(icon),
        move |result, _cursor| on_end(matches!(result, drag::DragResult::Dropped)),
        drag::Options {
            skip_animatation_on_cancel_or_failure: true,
            mode: drag::DragMode::Copy,
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn start_native_file_drag<F: Fn(bool) + Send + 'static>(
    _window: &WebviewWindow,
    _path: std::path::PathBuf,
    _icon: Vec<u8>,
    _on_end: F,
) -> Result<(), String> {
    Err("native_tab_drag_unsupported".into())
}

/// Fin de la session de drag native (callback AppKit, main thread). Décide du
/// sort de l'onglet et prévient la fenêtre source :
/// - `claimed`  : une autre fenêtre Slate a déjà récupéré l'onglet (drop HTML) ;
/// - `merged`   : lâché sur une autre fenêtre Slate → on lui pousse l'onglet ;
/// - `local`    : lâché sur (ou annulé au-dessus de) la fenêtre source → rien ;
/// - `copied`   : accepté par une app tierce (Finder, Mail…) → le fichier est parti,
///                l'onglet reste ouvert ;
/// - `detached` : annulé hors de toute cible → tear-off dans une nouvelle fenêtre.
fn finish_native_tab_drag(app: &tauri::AppHandle, source_label: &str, dropped: bool) {
    let drag = app.state::<ActiveTabDrag>();
    let Ok(mut slot) = drag.0.lock() else {
        return;
    };
    let Some(active) = slot.as_mut() else {
        return;
    };
    if active.source_label != source_label || active.ended_at.is_some() {
        return;
    }
    active.ended_at = Some(std::time::Instant::now());
    let source = app.get_webview_window(source_label);
    let cursor = source
        .as_ref()
        .and_then(|win| win.cursor_position().ok())
        .map(|pos| (pos.x as f64, pos.y as f64));
    let over_source = match (&source, cursor) {
        (Some(win), Some((x, y))) => point_in_window(win, x, y).is_some(),
        _ => false,
    };

    let action = if active.claimed_by.is_some() {
        "claimed"
    } else if over_source {
        "local"
    } else if dropped {
        let merged = cursor
            .and_then(|(x, y)| find_tab_merge_target(app, source_label, x, y))
            .and_then(|(label, relative_x)| {
                let target = app.get_webview_window(&label)?;
                target
                    .emit(
                        "slate-merge-tab",
                        MergeTabPayload {
                            tab: active.payload.clone(),
                            relative_x,
                        },
                    )
                    .ok()?;
                bring_window_to_front(&target);
                Some(())
            });
        if merged.is_some() {
            active.claimed_by = Some("merged".into());
            "merged"
        } else {
            "copied"
        }
    } else {
        let (x, y) = match (&source, cursor) {
            (Some(win), Some((px, py))) => {
                let scale = win.scale_factor().unwrap_or(1.0);
                (Some(px / scale), Some(py / scale))
            }
            _ => (None, None),
        };
        let pending = app.state::<PendingDetachedTabs>();
        match spawn_detached_window(app, &pending, active.payload.clone(), x, y) {
            Ok(_) => "detached",
            Err(_) => "local",
        }
    };
    // Le fichier est parti ailleurs (ou en nouvelle fenêtre) : aucun `drop` HTML
    // Slate n'est à attendre, on libère tout de suite pour qu'un vrai PDF déposé
    // juste après soit bien ouvert.
    if matches!(action, "copied" | "detached") {
        *slot = None;
    }
    if let Some(win) = source {
        let _ = win.emit(
            "slate-tab-drag-ended",
            TabDragEnded {
                action: action.into(),
            },
        );
    }
}

fn point_in_window(win: &WebviewWindow, phys_x: f64, phys_y: f64) -> Option<(f64, f64, f64)> {
    let pos = win.inner_position().ok()?;
    let size = win.inner_size().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let left = pos.x as f64;
    let top = pos.y as f64;
    let width = size.width as f64;
    let height = size.height as f64;
    const PAD: f64 = 20.0;
    // La barre d'onglets est sous la titlebar macOS : on accepte aussi un drop
    // un peu au-dessus du webview (là où on vise « à côté » de l'onglet).
    let top_pad = 56.0 * scale;
    if phys_x + PAD < left
        || phys_x - PAD > left + width
        || phys_y + top_pad < top
        || phys_y - PAD > top + height
    {
        return None;
    }
    Some((left, top, (phys_x - left) / scale))
}

fn find_tab_merge_target(
    app: &tauri::AppHandle,
    source_label: &str,
    phys_x: f64,
    phys_y: f64,
) -> Option<(String, f64)> {
    const TAB_STRIP_H: f64 = 72.0;
    let mut strip_hit = None;
    let mut window_hit = None;
    for (label, win) in app.webview_windows() {
        if label == source_label {
            continue;
        }
        let Some((_left, top, relative_x)) = point_in_window(&win, phys_x, phys_y) else {
            continue;
        };
        let scale = win.scale_factor().unwrap_or(1.0);
        if phys_y <= top + TAB_STRIP_H * scale {
            strip_hit = Some((label, relative_x));
        } else {
            window_hit = Some((label, relative_x));
        }
    }
    strip_hit.or(window_hit)
}

#[tauri::command]
fn quit_application(app: tauri::AppHandle) {
    app.exit(0);
}

pub(crate) fn bring_window_to_front(window: &tauri::WebviewWindow) {
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
fn take_pending_print_files(state: State<'_, PendingPrints>) -> Vec<FileResult> {
    match state.0.lock() {
        Ok(mut buf) => std::mem::take(&mut *buf),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
async fn analyze_pdf_page(bytes: Vec<u8>, page: u32) -> Result<pdf_engine::PdfAnalysis, String> {
    pdf_engine::analyze_pdf_page(&bytes, page)
}

/// Réparation à l'ouverture (MuPDF) : réécrit les PDF dont la structure est
/// cassée (xref corrompue, objets tronqués) pour que l'édition native
/// (lopdf/PDFium) fonctionne. Réponse binaire : octets réparés, ou VIDE si le
/// document est déjà sain (les octets d'origine restent la référence).
#[tauri::command]
async fn repair_pdf_bytes(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    match alto_pdf_engine::pdf_mupdf::repair_pdf_if_needed(&bytes)? {
        Some(repaired) => Ok(tauri::ipc::Response::new(repaired)),
        None => Ok(tauri::ipc::Response::new(Vec::<u8>::new())),
    }
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

/// Édition de texte NATIVE (façon Adobe) : modifie l'objet texte du PDF en
/// place via PDFium (police embarquée réutilisée), stocke le document édité
/// dans le cache (les analyses/exports suivants la voient), et renvoie la
/// bande re-rendue + la ré-analyse de la page. Le frontend récupère les octets
/// complets via `get_cached_document` au moment de la synchronisation.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn edit_pdf_text_cached(
    state: State<'_, DocCache>,
    baselines: State<'_, DocBaselines>,
    id: String,
    page: u32,
    removed: Vec<u32>,
    insert_after: i64,
    insert_before: i64,
    inserted: String,
    strip_top: f64,
    strip_height: f64,
    scale: f64,
    expected_block_text: Option<String>,
    block_rect: Option<Vec<f64>>,
    replace_whitespace_run: bool,
) -> Result<pdf_engine::NativeTextEditReport, String> {
    let bytes = {
        let map = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
        map.get(&id).cloned()
    };
    let Some(bytes) = bytes else {
        return Err("cache_miss".to_string());
    };
    let rect = block_rect
        .as_ref()
        .filter(|r| r.len() == 4)
        .map(|r| (r[0], r[1], r[2], r[3]));
    // Versionnage : mémoriser le flux de contenu de la page AVANT sa toute
    // première édition (point de restauration exact pour l'undo).
    if let Ok(mut docs) = baselines.0.lock() {
        if docs.len() >= 8 && !docs.contains_key(&id) {
            docs.clear();
        }
        let pages = docs.entry(id.clone()).or_default();
        if !pages.contains_key(&page) {
            if let Ok(stream) = alto_pdf_engine::pdf_versioning::page_content_stream(&bytes, page)
            {
                pages.insert(page, stream);
            }
        }
    }
    let outcome = pdf_engine::edit_pdf_text_with_options(
        &bytes,
        page,
        &removed,
        insert_after,
        insert_before,
        &inserted,
        strip_top,
        strip_height,
        scale,
        expected_block_text.as_deref(),
        rect,
        replace_whitespace_run,
    )?;
    if let Ok(mut map) = state.0.lock() {
        map.insert(id, outcome.bytes);
    }
    Ok(outcome.report)
}

/// Restaure le flux de contenu D'ORIGINE d'une page dans le document en cache
/// (undo par versionnage). Renvoie false si aucun point de restauration
/// n'existe pour cette page (aucune édition native depuis l'ouverture) — le
/// frontend retombe alors sur la réconciliation par diff.
#[tauri::command]
fn restore_native_page(
    state: State<'_, DocCache>,
    baselines: State<'_, DocBaselines>,
    id: String,
    page: u32,
) -> Result<bool, String> {
    let baseline = {
        let docs = baselines
            .0
            .lock()
            .map_err(|_| "baseline lock poisoned".to_string())?;
        docs.get(&id).and_then(|pages| pages.get(&page)).cloned()
    };
    let Some(stream) = baseline else {
        return Ok(false);
    };
    let bytes = {
        let map = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
        map.get(&id).cloned()
    };
    let Some(bytes) = bytes else {
        return Err("cache_miss".to_string());
    };
    let restored =
        alto_pdf_engine::pdf_versioning::replace_page_content_streams(&bytes, &[(page, stream)])?;
    if let Ok(mut map) = state.0.lock() {
        map.insert(id, restored);
    }
    Ok(true)
}

/// Rendu PDFium pleine page (PNG base64) à partir du document en cache. Le
/// frontend bascule le canvas dessus à l'entrée en édition native : les bandes
/// re-rendues après chaque frappe (même rasteriseur) deviennent alors
/// pixel-identiques hors caractères réellement modifiés — plus aucun
/// « changement d'état » perçu à la première frappe.
#[tauri::command]
async fn render_pdf_page_cached(
    state: State<'_, DocCache>,
    id: String,
    page: u32,
    scale: f64,
) -> Result<pdf_engine::RenderedPagePng, String> {
    let bytes = {
        let map = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
        map.get(&id).cloned()
    };
    let Some(bytes) = bytes else {
        return Err("cache_miss".to_string());
    };
    pdf_engine::render_pdf_page_png(&bytes, page, scale)
}

/// Octets COURANTS du document en cache (édités nativement inclus). Réponse
/// binaire brute (pas de JSON) : c'est le document complet.
#[tauri::command]
fn get_cached_document(state: State<'_, DocCache>, id: String) -> Result<tauri::ipc::Response, String> {
    let map = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
    match map.get(&id) {
        Some(bytes) => Ok(tauri::ipc::Response::new(bytes.clone())),
        None => Err("cache_miss".to_string()),
    }
}

/// Extrait les polices embarquées d'une page (octets base64 indexés par nom),
/// à partir du document déjà en cache. Sert à charger la VRAIE police dans la
/// WebView (FontFace) pour un aperçu d'édition fidèle au natif. Renvoie
/// `cache_miss` si le document n'a pas encore été mis en cache (même protocole
/// que `analyze_pdf_page_cached`).
#[tauri::command]
async fn extract_embedded_fonts_cached(
    state: State<'_, DocCache>,
    id: String,
    page: u32,
) -> Result<std::collections::HashMap<String, String>, String> {
    let bytes = {
        let map = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
        map.get(&id).cloned()
    };
    let Some(bytes) = bytes else {
        return Err("cache_miss".to_string());
    };
    pdf_engine::extract_embedded_fonts(&bytes, page)
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

/// Export hybride : ne ré-aplatit que les pages éditées (jpeg fourni) et
/// conserve les autres en texte natif depuis le PDF d'origine.
#[tauri::command]
async fn export_edited_pdf_native(
    original: Vec<u8>,
    pages: Vec<pdf_engine::EditedPage>,
) -> Result<tauri::ipc::Response, String> {
    pdf_engine::export_edited_pdf_native(&original, pages).map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn export_edited_pdf_vector(
    original: Vec<u8>,
    mut operations: Vec<pdf_engine::VectorTextOperation>,
) -> Result<pdf_engine::VectorExportResult, String> {
    // Résout chaque famille demandée en octets de police embarquables (font_kit).
    // Le moteur (pdf-engine) ne dépend pas de font_kit : on lui passe les octets.
    for op in operations.iter_mut() {
        if let Some(family) = op.font_family.clone() {
            op.font_bytes = system_fonts::font_data_for_family(&family, op.bold, op.italic);
        }
    }
    pdf_engine::export_edited_pdf_vector(&original, operations)
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

/// Bouton image d'un formulaire (équivalent du `buttonImportIcon()` d'Acrobat).
#[tauri::command]
async fn set_form_button_image(
    bytes: Vec<u8>,
    field_name: String,
    image: Vec<u8>,
) -> Result<tauri::ipc::Response, String> {
    pdf_forms::set_form_button_image(&bytes, &field_name, &image).map(tauri::ipc::Response::new)
}

/// Après un remplissage PDF.js : bordures « soulignées » restaurées.
#[tauri::command]
async fn normalize_form_appearances(bytes: Vec<u8>) -> Result<tauri::ipc::Response, String> {
    pdf_forms::normalize_form_appearances(&bytes).map(tauri::ipc::Response::new)
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
async fn set_pdf_metadata(
    bytes: Vec<u8>,
    title: Option<String>,
    author: Option<String>,
    subject: Option<String>,
    keywords: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    pdf_edit::set_metadata(
        &bytes,
        title.as_deref(),
        author.as_deref(),
        subject.as_deref(),
        keywords.as_deref(),
    )
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn convert_pdf_colors_fogra39(
    bytes: Vec<u8>,
    icc_path: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    // Ghostscript peut prendre plusieurs secondes : on sort du thread async Tauri.
    let result = tauri::async_runtime::spawn_blocking(move || {
        pdf_color::convert_to_fogra39(&bytes, icc_path.as_deref())
    })
    .await
    .map_err(|e| format!("Conversion interrompue : {e}"))??;
    Ok(tauri::ipc::Response::new(result.bytes))
}

#[tauri::command]
async fn fogra39_profile_status() -> Result<Option<String>, String> {
    Ok(pdf_color::fogra39_profile_available())
}

#[tauri::command]
async fn list_printers() -> Result<Vec<print_cups::PrinterInfo>, String> {
    tauri::async_runtime::spawn_blocking(print_cups::list_printers)
        .await
        .map_err(|e| format!("list_printers interrompu : {e}"))?
}

#[tauri::command]
async fn list_paper_sizes(printer: String) -> Result<Vec<print_cups::PaperSize>, String> {
    tauri::async_runtime::spawn_blocking(move || print_cups::list_paper_sizes(&printer))
        .await
        .map_err(|e| format!("list_paper_sizes interrompu : {e}"))?
}

/// Recadre une étiquette sur son contenu et l’adapte au format cible.
///
/// N’altère jamais le document ouvert dans l’éditeur : la conversion porte
/// uniquement sur les octets qu’on s’apprête à envoyer à l’imprimante (ou à
/// afficher dans l’aperçu du panneau).
#[tauri::command]
async fn fit_label_to_media(
    bytes: Vec<u8>,
    target: print_layout::LabelTarget,
) -> Result<print_layout::LabelFitResult, String> {
    tauri::async_runtime::spawn_blocking(move || print_layout::fit_label_to_media(&bytes, &target))
        .await
        .map_err(|e| format!("Recadrage d’étiquette interrompu : {e}"))?
}

#[tauri::command]
async fn list_printer_options(printer: String) -> Result<Vec<print_cups::PrinterOption>, String> {
    tauri::async_runtime::spawn_blocking(move || print_cups::list_printer_options(&printer))
        .await
        .map_err(|e| format!("list_printer_options interrompu : {e}"))?
}

#[tauri::command]
async fn print_pdf_with_options(
    bytes: Vec<u8>,
    options: print_cups::PrintOptions,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || print_cups::print_pdf_with_options(&bytes, &options))
        .await
        .map_err(|e| format!("Impression interrompue : {e}"))?
}

#[tauri::command]
async fn read_pdf_path(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

fn handler_id_is_slate(id: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return false;
    }
    if id.contains("soflution.slate") {
        return true;
    }
    let file_name = id.rsplit(['\\', '/']).next().unwrap_or(&id);
    let stem = file_name
        .strip_suffix(".desktop")
        .or_else(|| file_name.strip_suffix(".exe"))
        .unwrap_or(file_name);
    stem == "slate" || stem == "com.soflution.slate"
}

#[cfg(target_os = "macos")]
fn macos_role_handler(uti: &str, role: u32) -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
        ) -> CFStringRef;
    }

    let content_type = CFString::new(uti);
    let handler_ref = unsafe {
        LSCopyDefaultRoleHandlerForContentType(content_type.as_concrete_TypeRef(), role)
    };
    if handler_ref.is_null() {
        return None;
    }
    let handler = unsafe { CFString::wrap_under_create_rule(handler_ref) };
    Some(handler.to_string())
}

#[cfg(target_os = "macos")]
fn macos_set_role_handler(uti: &str, role: u32) -> i32 {
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

    let content_type = CFString::new(uti);
    let bundle_id = CFString::new("com.soflution.slate");
    unsafe {
        LSSetDefaultRoleHandlerForContentType(
            content_type.as_concrete_TypeRef(),
            role,
            bundle_id.as_concrete_TypeRef(),
        )
    }
}

#[cfg(target_os = "macos")]
fn open_default_app_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Default-Apps-Settings")
        .spawn();
}

#[cfg(target_os = "windows")]
fn open_default_app_settings() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:defaultapps"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[cfg(target_os = "linux")]
fn open_default_app_settings() {
    for command in ["xdg-open", "gnome-control-center"] {
        if std::process::Command::new(command)
            .arg("default-apps")
            .spawn()
            .is_ok()
        {
            return;
        }
    }
}

#[tauri::command]
fn set_default_pdf_handler() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const K_LS_ROLES_VIEWER: u32 = 0x0000_0002;
        const K_LS_ROLES_EDITOR: u32 = 0x0000_0004;
        const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
        for uti in ["com.adobe.pdf", "org.iso.pdf"] {
            for role in [K_LS_ROLES_VIEWER, K_LS_ROLES_EDITOR, K_LS_ROLES_ALL] {
                let _ = macos_set_role_handler(uti, role);
            }
        }
        if is_default_pdf_handler() {
            return Ok(());
        }
        open_default_app_settings();
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        if is_default_pdf_handler() {
            return Ok(());
        }
        open_default_app_settings();
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let desktop_names = [
            "com.soflution.slate.desktop",
            "slate.desktop",
            "Slate.desktop",
        ];
        let mut set_ok = false;
        for desktop in desktop_names {
            if std::process::Command::new("xdg-mime")
                .args(["default", desktop, "application/pdf"])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
            {
                set_ok = true;
                break;
            }
        }
        if set_ok && is_default_pdf_handler() {
            return Ok(());
        }
        open_default_app_settings();
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Impossible de définir le lecteur PDF par défaut sur cette plateforme.".to_string())
    }
}

#[tauri::command]
fn is_default_pdf_handler() -> bool {
    #[cfg(target_os = "macos")]
    {
        const K_LS_ROLES_VIEWER: u32 = 0x0000_0002;
        const K_LS_ROLES_EDITOR: u32 = 0x0000_0004;
        const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
        for uti in ["com.adobe.pdf", "org.iso.pdf"] {
            for role in [K_LS_ROLES_VIEWER, K_LS_ROLES_EDITOR, K_LS_ROLES_ALL] {
                if macos_role_handler(uti, role).is_some_and(|id| handler_id_is_slate(&id)) {
                    return true;
                }
            }
        }
        false
    }

    #[cfg(target_os = "windows")]
    {
        windows_pdf_handler_is_slate()
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("xdg-mime")
            .args(["query", "default", "application/pdf"])
            .output();
        match output {
            Ok(out) if out.status.success() => {
                handler_id_is_slate(&String::from_utf8_lossy(&out.stdout))
            }
            _ => false,
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
fn windows_pdf_handler_is_slate() -> bool {
    const USER_CHOICE: &str =
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice";
    const CLASSES_PDF: &str = r"HKCU\Software\Classes\.pdf";
    for key in [USER_CHOICE, CLASSES_PDF] {
        if let Some(value) = windows_reg_query(key, "ProgId")
            .or_else(|| windows_reg_query(key, "(Default)"))
        {
            if handler_id_is_slate(&value) {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn windows_reg_query(key: &str, value_name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", key, "/v", value_name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let line = line.trim();
        if let Some(pos) = line.find("REG_SZ").or_else(|| line.find("REG_EXPAND_SZ")) {
            let start = if line[pos..].starts_with("REG_EXPAND_SZ") {
                pos + "REG_EXPAND_SZ".len()
            } else {
                pos + "REG_SZ".len()
            };
            let value = line[start..].trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Langue pour les libellés de dialogues fichier (filtres). Sur macOS, suit
/// le réglage Slate persisté ; sinon LANG/LC_ALL.
fn dialog_ui_is_french() -> bool {
    #[cfg(target_os = "macos")]
    {
        return mac_print::effective_ui_language().starts_with("fr");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let locale = std::env::var("LANG")
            .or_else(|_| std::env::var("LC_ALL"))
            .unwrap_or_default()
            .to_lowercase();
        locale.starts_with("fr")
    }
}

fn dialog_filter_pdf() -> &'static str {
    if dialog_ui_is_french() {
        "Documents PDF"
    } else {
        "PDF Documents"
    }
}

fn dialog_filter_images() -> &'static str {
    if dialog_ui_is_french() {
        "Images"
    } else {
        "Images"
    }
}

fn dialog_filter_certificates() -> &'static str {
    if dialog_ui_is_french() {
        "Certificats (.p12, .pfx)"
    } else {
        "Certificates (.p12, .pfx)"
    }
}

fn dialog_filter_for_extension(extension: &str) -> &'static str {
    match extension {
        "pdf" => dialog_filter_pdf(),
        "json" => {
            if dialog_ui_is_french() {
                "Fichiers JSON"
            } else {
                "JSON Files"
            }
        }
        _ => {
            if dialog_ui_is_french() {
                "Fichiers"
            } else {
                "Files"
            }
        }
    }
}

#[tauri::command]
async fn pick_multiple_pdfs(app: tauri::AppHandle) -> Result<Vec<FileResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    #[cfg(target_os = "macos")]
    mac_print::apply_persisted_apple_languages();

    let files = app
        .dialog()
        .file()
        .add_filter(dialog_filter_pdf(), &["pdf"])
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

    #[cfg(target_os = "macos")]
    mac_print::apply_persisted_apple_languages();

    let file = app
        .dialog()
        .file()
        .add_filter(dialog_filter_certificates(), &["p12", "pfx"])
        .blocking_pick_file();

    Ok(file.map(|fp| fp.to_string()))
}

/// Imprime un PDF via le dialogue d'impression natif du système.
/// `window.print()` est inopérant dans le WebView macOS (WKWebView), on passe
/// donc par un fichier temporaire + l'imprimante du système.
#[tauri::command]
async fn print_pdf(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Le contenu à imprimer n'est pas un PDF valide.".into());
    }

    // macOS : panneau d'impression natif DANS l'app (PDFKit), façon Acrobat.
    // Émet `alto-print-finished` à la fermeture du panneau.
    #[cfg(target_os = "macos")]
    {
        return mac_print::print_pdf_native(&app, bytes);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        let mut path = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        path.push(format!("alto-impression-{stamp}.pdf"));
        std::fs::write(&path, &bytes)
            .map_err(|e| format!("Écriture du fichier d'impression impossible : {e}"))?;
        let path_str = path.to_string_lossy().to_string();

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
}

/// Masque l'application (macOS : icône dans le Dock). Utilisé après une
/// impression depuis le Finder quand des documents étaient déjà ouverts.
#[tauri::command]
fn hide_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return mac_print::hide_app_native(&app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        Ok(())
    }
}

/// Force la langue des panneaux et menus natifs macOS (impression, enregistrer…)
/// pour qu'ils suivent le réglage de langue de Slate. Persiste sur disque et
/// écrit `AppleLanguages` ; AppKit applique pleinement au (re)lancement.
/// Passer "auto"/"" suit le système.
#[tauri::command]
fn set_native_language(lang: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac_print::set_apple_languages(&lang);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = lang;
    }
    Ok(())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = url.trim();
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("mailto:")
        || url.starts_with("ms-outlook:")
        || url.starts_with("msteams:");
    if !allowed {
        return Err("URL invalide".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Sélectionne une ou plusieurs images (PNG/JPEG) et renvoie leurs octets,
/// pour la fonction « Images → PDF ».
#[tauri::command]
async fn pick_images(app: tauri::AppHandle) -> Result<Vec<Vec<u8>>, String> {
    use tauri_plugin_dialog::DialogExt;

    #[cfg(target_os = "macos")]
    mac_print::apply_persisted_apple_languages();

    let files = app
        .dialog()
        .file()
        .add_filter(dialog_filter_images(), &["png", "jpg", "jpeg"])
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

    #[cfg(target_os = "macos")]
    mac_print::apply_persisted_apple_languages();

    let file_path = app
        .dialog()
        .file()
        .add_filter(dialog_filter_pdf(), &["pdf"])
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

    #[cfg(target_os = "macos")]
    mac_print::apply_persisted_apple_languages();

    let extension = extension.trim_start_matches('.').to_string();
    let filter_name = dialog_filter_for_extension(&extension);

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
            // Chemin filesystem (pas file://) pour que le front mette à jour
            // le nom d'onglet immédiatement après un renommage à l'export.
            let path_buf = fp.into_path().map_err(|e| e.to_string())?;
            let path_str = path_buf.to_string_lossy().to_string();
            std::fs::write(&path_buf, &data).map_err(|e| e.to_string())?;
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}

/// Prépare une copie du PDF dans un dossier temporaire pour le partage
/// (document modifié ou ouvert sans chemin disque connu).
#[tauri::command]
fn prepare_share_pdf(data: Vec<u8>, filename: String) -> Result<String, String> {
    if data.is_empty() {
        return Err("empty_document".to_string());
    }
    let dir = std::env::temp_dir().join("slate-share");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut safe: String = filename
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    if safe.is_empty() {
        safe = "document.pdf".to_string();
    }
    if !safe.to_ascii_lowercase().ends_with(".pdf") {
        safe.push_str(".pdf");
    }
    let path = dir.join(&safe);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn sanitize_autosave_component(value: &str, fallback: &str) -> String {
    let mut safe: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        safe = fallback.to_string();
    }
    safe
}

fn edit_history_path(app: &tauri::AppHandle, file_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("missing_path".to_string());
    }
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    trimmed.hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("edit-history");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.json")))
}

/// Historique d'édition (undo/redo) persisté hors localStorage — l'autosave
/// écrase le PDF sans dialogue, il faut pouvoir revenir en arrière à la réouverture.
#[tauri::command]
fn write_edit_history(
    app: tauri::AppHandle,
    file_path: String,
    payload: String,
) -> Result<(), String> {
    if payload.len() > 12 * 1024 * 1024 {
        return Err("history_too_large".to_string());
    }
    let path = edit_history_path(&app, &file_path)?;
    std::fs::write(&path, payload.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_edit_history(app: tauri::AppHandle, file_path: String) -> Result<Option<String>, String> {
    let path = edit_history_path(&app, &file_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(data))
}

fn app_data_file(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn write_fsync(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

/// Onglets ouverts hors localStorage — survit au remplacement du .app par l'updater.
#[tauri::command]
fn write_open_session(app: tauri::AppHandle, payload: String) -> Result<(), String> {
    if payload.len() > 512 * 1024 {
        return Err("session_too_large".to_string());
    }
    let path = app_data_file(&app, "open-session.json")?;
    write_fsync(&path, payload.as_bytes())
}

#[tauri::command]
fn read_open_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app_data_file(&app, "open-session.json")?;
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(data))
}

pub(crate) fn write_update_relaunch_flag(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app_data_file(app, "relaunch-from-update")?;
    write_fsync(&path, b"1")
}

#[tauri::command]
fn mark_update_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    write_update_relaunch_flag(&app)
}

#[tauri::command]
fn consume_update_relaunch(app: tauri::AppHandle) -> Result<bool, String> {
    let path = app_data_file(&app, "relaunch-from-update")?;
    if !path.exists() {
        return Ok(false);
    }
    let _ = std::fs::remove_file(&path);
    Ok(true)
}

/// Copie de secours (document sans chemin, ou autosave décoché avant màj/fermeture).
#[tauri::command]
fn write_autosave(
    app: tauri::AppHandle,
    id: String,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() {
        return Err("empty_document".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("autosave");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_id = sanitize_autosave_component(&id, "doc");
    let mut safe_name = sanitize_autosave_component(&filename, "document.pdf");
    if !safe_name.to_ascii_lowercase().ends_with(".pdf") {
        safe_name.push_str(".pdf");
    }
    let path = dir.join(format!("{safe_id}-{safe_name}"));
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Affiche le fichier dans le Finder (macOS) ou l'explorateur (Windows/Linux).
#[tauri::command]
fn reveal_file_in_folder(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() || !std::path::Path::new(path).exists() {
        return Err("file_not_found".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let parent = std::path::Path::new(path)
            .parent()
            .ok_or_else(|| "file_not_found".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    // Le moteur PDF vit désormais dans le crate `alto-pdf-engine` : son
    // `CARGO_MANIFEST_DIR` ne pointe plus vers `src-tauri`. En dev/CI la dylib
    // PDFium est à la racine de `src-tauri`, on l'expose donc explicitement comme
    // dossier de recherche (ignoré en prod : c'est le dossier de l'exécutable qui prime).
    if std::env::var_os("ALTO_PDFIUM_DIR").is_none() {
        std::env::set_var("ALTO_PDFIUM_DIR", env!("CARGO_MANIFEST_DIR"));
    }

    // Langue AppKit AVANT le Builder : sinon NSSavePanel / impression restent
    // en anglais (AppleLanguages lu trop tard dans setup()).
    #[cfg(target_os = "macos")]
    mac_print::apply_persisted_apple_languages();

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init()
        .ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingOpens::default())
        .manage(PendingPrints::default())
        .manage(PendingDetachedTabs::default())
        .manage(ActiveTabDrag::default())
        .manage(DocCache::default())
        .manage(DocBaselines::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            mac_print::apply_persisted_apple_languages();

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
            // Quitter via le frontend (et non PredefinedMenuItem::quit, qui
            // termine le process immédiatement) : la page vérifie les
            // modifications non enregistrées et propose de les sauvegarder.
            let quit = MenuItemBuilder::new("Quitter Slate")
                .id("request-quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
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
            // Item « Imprimer » avec raccourci natif ⌘P : macOS route alors Cmd+P
            // vers le menu (→ alto-print → impression du PDF) au lieu de laisser le
            // WebView ouvrir sa propre impression (qui imprimerait l'UI de l'app).
            let print_item = MenuItemBuilder::new("Imprimer...")
                .id("print")
                .accelerator("CmdOrCtrl+P")
                .build(app)?;
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
                .text("share-pdf", "Partager le fichier")
                .separator()
                .item(&print_item)
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
                .text("add-image-file", "Depuis un fichier...")
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
                .text("add-text", "Ajouter du texte")
                .item(&add_image_menu)
                .text("add-signature", "Ajouter une signature")
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
            let prepress_menu = SubmenuBuilder::new(app, "Utiliser le prépresse")
                .text("convert-colors", "Convertir les couleurs…")
                .text("prepress", "Ouvrir le panneau prépresse")
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "Affichage")
                .item(&rotate_view_menu)
                .item(&page_navigation_menu)
                .item(&display_menu)
                .item(&zoom_menu)
                .separator()
                .item(&prepress_menu)
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

            // Branche l'impression depuis le Finder (Apple Event « print documents »).
            #[cfg(target_os = "macos")]
            mac_print::install(app.handle().clone());
            // Ouverture à chaud (Mail / quarantaine) via Apple Event odoc.
            #[cfg(target_os = "macos")]
            mac_open::install(app.handle().clone());

            updater::start_background_checks(app.handle().clone());

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
                "add-text" => Some("alto-add-text"),
                "add-image-file" => Some("alto-add-image"),
                "add-signature" => Some("alto-add-signature"),
                "focus-search" => Some("alto-focus-search"),
                "ocr-page" => Some("alto-ocr-page"),
                "toggle-tools" => Some("alto-toggle-tools"),
                "print" => Some("alto-print"),
                "prev-page" => Some("alto-prev-page"),
                "next-page" => Some("alto-next-page"),
                "close-file" => Some("alto-close-file"),
                "request-quit" => Some("alto-request-quit"),
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
                "share-pdf" => Some("alto-share-pdf"),
                "prepress" => Some("alto-prepress"),
                "convert-colors" => Some("alto-convert-colors"),
                id if id.starts_with("unsupported")
                    || id == "about"
                    || id == "about-plugins"
                    || id == "window-current-file" =>
                {
                    Some("alto-menu-unsupported")
                }
                _ => None,
            };

            if event.id().as_ref() == "new-window" {
                let _ = spawn_empty_window(app.clone());
            } else if let Some(event_name) = event_name {
                if let Some(window) = focused_webview(app) {
                    let _ = window.emit(event_name, ());
                } else if event_name == "alto-request-quit" {
                    // Aucune fenêtre pour arbitrer les modifications non
                    // enregistrées : quitter directement (rien à perdre).
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            analyze_pdf_page,
            cache_document,
            analyze_pdf_page_cached,
            edit_pdf_text_cached,
            restore_native_page,
            repair_pdf_bytes,
            render_pdf_page_cached,
            get_cached_document,
            extract_embedded_fonts_cached,
            alto_debug,
            ocr_page,
            ocr_pdf_page,
            export_edited_pdf,
            export_edited_pdf_native,
            export_edited_pdf_vector,
            list_system_fonts,
            create_blank_pdf,
            open_file,
            save_file,
            save_file_dialog,
            write_autosave,
            write_edit_history,
            read_edit_history,
            write_open_session,
            read_open_session,
            mark_update_relaunch,
            consume_update_relaunch,
            prepare_share_pdf,
            reveal_file_in_folder,
            take_pending_open_files,
            take_pending_print_files,
            spawn_document_window,
            spawn_empty_window,
            take_detached_tab,
            begin_tab_drag,
            claim_tab_drag,
            cancel_tab_drag,
            is_tab_drag_active,
            start_tab_native_drag,
            quit_application,
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
            set_pdf_metadata,
            convert_pdf_colors_fogra39,
            fogra39_profile_status,
            list_printers,
            list_paper_sizes,
            list_printer_options,
            fit_label_to_media,
            print_pdf_with_options,
            read_pdf_path,
            set_default_pdf_handler,
            is_default_pdf_handler,
            pick_multiple_pdfs,
            open_external,
            print_pdf,
            hide_app,
            set_native_language,
            watermark_pdf,
            add_page_numbers,
            images_to_pdf,
            remove_password,
            crop_pdf,
            flatten_pdf,
            extract_images,
            list_form_fields,
            fill_form_fields,
            set_form_button_image,
            normalize_form_appearances,
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
            match &_event {
                // Une fois NSApp lancé, ré-arme les handlers d'impression : à ce
                // stade le delegate existe et notre handler Apple Event n'est plus
                // écrasé par finishLaunching.
                tauri::RunEvent::Ready => {
                    mac_print::rearm();
                    mac_open::rearm();
                }
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        if let Ok(path) = url.to_file_path() {
                            dispatch_open_path(_app, &path);
                        }
                    }
                }
                _ => {}
            }
        });
}
