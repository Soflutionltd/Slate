//! MCP local : Cursor, Claude Code et Claude Desktop installés sur ce Mac pilotent
//! le document ouvert dans Slate, sans Internet. Mêmes outils que le relais distant
//! (`ai-tools.json`), exécutés par la page avec le même `executeAiTool` : la page
//! garde seule les confirmations et l'historique.
//!
//! Streamable HTTP sans session (rmcp), 127.0.0.1 seulement, Host limité aux
//! adresses locales (DNS rebinding), jeton Bearer de 32 octets comparé à temps
//! constant. Le jeton ne sort que vers la fenêtre « Connecter un agent ».

use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt as _, Full};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::Rng as _;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;
use subtle::ConstantTimeEq as _;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tower_service::Service as _;

const DEFAULT_PORT: u16 = 47826;
const PORT_ENV: &str = "SLATE_MCP_PORT";
const MCP_PATH: &str = "/mcp";
const TOKEN_FILE: &str = "mcp-token";
const SETTINGS_FILE: &str = "mcp-local.json";
/// Même délai que le relais : un outil peut attendre une confirmation dans Slate.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_MAX_WIDTH: u32 = 1600;
const CALL_EVENT: &str = "mcp-local-call";
const SCREENSHOT_TOOL: &str = "screenshot";
const SKILL_NAME: &str = "slate";
const SKILL: &str = include_str!("../skills/slate/SKILL.md");
const CATALOG_JSON: &str = include_str!("../frontend-dist/ai-tools.json");
const LOCAL_INSTRUCTIONS: &str = "\n\nOn this Mac you also have `screenshot`: a PNG of the Slate window exactly as the user sees it (panels, selection, unsaved edits).";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// --- Catalogue -------------------------------------------------------------

struct Catalog {
    instructions: String,
    tools: Vec<Tool>,
    names: HashSet<String>,
}

fn annotations(tool: &Value) -> ToolAnnotations {
    let risk = tool["risk"].as_str().unwrap_or("edit");
    let base = ToolAnnotations::new().read_only(risk == "read").open_world(false);
    let base = if risk == "read" { base } else { base.destructive(risk == "destructive").idempotent(false) };
    if tool["idempotent"].as_bool() == Some(true) { base.idempotent(true) } else { base }
}

fn parse_catalog(text: &str) -> Result<Catalog, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("ai-tools.json: {e}"))?;
    let instructions = value["instructions"].as_str().ok_or("ai-tools.json: instructions missing")?;
    let mut tools = Vec::new();
    let mut names = HashSet::new();
    for tool in value["tools"].as_array().ok_or("ai-tools.json: tools missing")? {
        let name = tool["name"].as_str().ok_or("ai-tools.json: tool without name")?;
        let schema = tool["input_schema"].as_object().cloned().unwrap_or_default();
        let mut entry = Tool::new(name.to_string(), tool["description"].as_str().unwrap_or_default().to_string(), Arc::new(schema))
            .with_annotations(annotations(tool));
        if let Some(title) = tool["title"].as_str() {
            entry = entry.with_title(title);
        }
        names.insert(name.to_string());
        tools.push(entry);
    }
    let mut schema = Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), json!({}));
    tools.push(
        Tool::new(SCREENSHOT_TOOL, "PNG screenshot of the Slate window as the user sees it.", Arc::new(schema))
            .with_title("Screenshot the Slate window")
            .with_annotations(ToolAnnotations::new().read_only(true).open_world(false)),
    );
    Ok(Catalog { instructions: format!("{instructions}{LOCAL_INSTRUCTIONS}"), tools, names })
}

fn catalog() -> Result<&'static Catalog, String> {
    static CATALOG: OnceLock<Result<Catalog, String>> = OnceLock::new();
    CATALOG.get_or_init(|| parse_catalog(CATALOG_JSON)).as_ref().map_err(Clone::clone)
}

// --- Pont avec la page -----------------------------------------------------

#[derive(Deserialize)]
pub struct PageReply {
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<String>,
}

/// Appel en attente de la page : la fenêtre qui l'a reçu, et où envoyer sa réponse.
type PendingCall = (String, oneshot::Sender<PageReply>);

static PENDING: Mutex<Option<HashMap<String, PendingCall>>> = Mutex::new(None);
/// Fenêtres dont la page écoute les appels (prête après le chargement d'app.js).
static READY: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn random_id() -> String {
    rand::rng().sample_iter(rand::distr::Alphanumeric).take(24).map(char::from).collect()
}

/// La fenêtre au premier plan, sinon la principale, sinon la première ouverte.
fn target_window(app: &AppHandle) -> Option<WebviewWindow> {
    let windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    windows
        .iter()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.iter().find(|window| window.label() == "main"))
        .or_else(|| windows.first())
        .cloned()
}

fn failure(text: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

/// Comme le relais : les images jointes sous `_mcpContent` deviennent des blocs image.
fn page_result(result: Value) -> CallToolResult {
    let (json, images) = match result {
        Value::Object(mut map) => {
            let extra = map.remove("_mcpContent");
            (Value::Object(map), extra)
        }
        other => (other, None),
    };
    let mut content = vec![ContentBlock::text(serde_json::to_string_pretty(&json).unwrap_or_default())];
    for block in extra_images(images) {
        content.push(block);
    }
    CallToolResult::success(content)
}

fn extra_images(extra: Option<Value>) -> Vec<ContentBlock> {
    let Some(Value::Array(blocks)) = extra else { return Vec::new() };
    blocks
        .into_iter()
        .filter_map(|block| {
            let data = block["data"].as_str()?;
            let mime = block["mimeType"].as_str().filter(|mime| mime.starts_with("image/"))?;
            (block["type"] == "image").then(|| ContentBlock::image(data, mime))
        })
        .collect()
}

async fn call_page(app: &AppHandle, tool: &str, args: Value, client: &str) -> CallToolResult {
    let Some(window) = target_window(app) else {
        return failure("Slate has no window open. Ask the user to open Slate, then call open_document.");
    };
    let label = window.label().to_string();
    if !lock(&READY).as_ref().is_some_and(|ready| ready.contains(&label)) {
        return failure("Slate is still starting. Retry in a few seconds.");
    }
    let id = random_id();
    let (tx, rx) = oneshot::channel();
    lock(&PENDING).get_or_insert_with(HashMap::new).insert(id.clone(), (label.clone(), tx));
    let payload = json!({ "id": id, "tool": tool, "args": args, "client": client });
    if window.emit_to(label.as_str(), CALL_EVENT, payload).is_err() {
        take_pending(&id);
        return failure("Slate could not receive the call. Ask the user to check that Slate is open, then retry.");
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(reply)) if reply.ok => page_result(reply.result),
        Ok(Ok(reply)) => failure(reply.error.as_deref().unwrap_or("Slate could not run this tool.")),
        Ok(Err(_)) => failure("Slate closed or reloaded its window while running the tool. Retry."),
        Err(_) => {
            take_pending(&id);
            failure("Slate did not answer within 2 minutes. The document may be very large, or the user has not answered a confirmation in Slate yet.")
        }
    }
}

fn take_pending(id: &str) -> Option<oneshot::Sender<PageReply>> {
    lock(&PENDING).as_mut().and_then(|pending| pending.remove(id)).map(|(_, tx)| tx)
}

#[tauri::command]
pub fn mcp_local_reply(id: String, reply: PageReply) {
    if let Some(tx) = take_pending(&id) {
        let _ = tx.send(reply);
    }
}

#[tauri::command]
pub fn mcp_local_ready(window: WebviewWindow) {
    let label = window.label().to_string();
    drop_pending(&label);
    lock(&READY).get_or_insert_with(HashSet::new).insert(label);
}

pub fn forget_window(label: &str) {
    if let Some(ready) = lock(&READY).as_mut() {
        ready.remove(label);
    }
    drop_pending(label);
}

/// Page rechargée ou fenêtre détruite : ses appels en cours échouent tout de suite
/// au lieu d'attendre le délai, la nouvelle page ne connaît pas leurs identifiants.
fn drop_pending(label: &str) {
    if let Some(pending) = lock(&PENDING).as_mut() {
        pending.retain(|_, (window, _)| window != label);
    }
}

// --- Capture de la fenêtre --------------------------------------------------

#[cfg(target_os = "macos")]
fn snapshot_png(image: *mut objc2_app_kit::NSImage) -> Option<Vec<u8>> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;
    // SAFETY : WebKit passe une NSImage valide (ou nil) pendant l'appel du bloc.
    let image = unsafe { image.as_ref() }?;
    let tiff = image.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    // SAFETY : dictionnaire de propriétés vide, type PNG reconnu par AppKit.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(png.to_vec())
}

#[cfg(target_os = "macos")]
async fn capture_window(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let (tx, rx) = oneshot::channel::<Option<Vec<u8>>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    window
        .with_webview(move |webview| {
            let tx = tx.clone();
            let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                if let Some(tx) = lock(&tx).take() {
                    let _ = tx.send(snapshot_png(image));
                }
            });
            // SAFETY : `inner()` est le WKWebView de la fenêtre, appelé sur le thread principal.
            unsafe {
                let view = &*webview.inner().cast::<WKWebView>();
                view.takeSnapshotWithConfiguration_completionHandler(None, &block);
            }
        })
        .map_err(|e| e.to_string())?;
    let png = tokio::time::timeout(SNAPSHOT_TIMEOUT, rx)
        .await
        .map_err(|_| "The Slate window did not answer the screenshot request.".to_string())?
        .map_err(|_| "The screenshot was cancelled.".to_string())?
        .ok_or_else(|| "macOS could not capture the Slate window.".to_string())?;
    downscale_png(png)
}

#[cfg(not(target_os = "macos"))]
async fn capture_window(_window: &WebviewWindow) -> Result<Vec<u8>, String> {
    Err("Screenshots are only available on macOS.".to_string())
}

/// Un écran Retina donne une image de 3 000 px : on la ramène à 1 600 px de large.
fn downscale_png(png: Vec<u8>) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    if image.width() <= SNAPSHOT_MAX_WIDTH {
        return Ok(png);
    }
    let height = (u64::from(image.height()) * u64::from(SNAPSHOT_MAX_WIDTH) / u64::from(image.width())) as u32;
    let resized = image.resize_exact(SNAPSHOT_MAX_WIDTH, height.max(1), image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    resized.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

async fn screenshot(app: &AppHandle) -> CallToolResult {
    let Some(window) = target_window(app) else {
        return failure("Slate has no window open. Ask the user to open Slate.");
    };
    match capture_window(&window).await {
        Ok(png) => CallToolResult::success(vec![ContentBlock::image(
            base64::engine::general_purpose::STANDARD.encode(png),
            "image/png",
        )]),
        Err(error) => failure(&error),
    }
}

// --- Serveur MCP -------------------------------------------------------------

#[derive(Clone)]
struct SlateMcp {
    app: AppHandle,
}

impl ServerHandler for SlateMcp {
    fn get_info(&self) -> ServerConfig {
        let config = ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("slate", env!("CARGO_PKG_VERSION")));
        match catalog() {
            Ok(catalog) => config.with_instructions(catalog.instructions.clone()),
            Err(_) => config,
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let catalog = catalog().map_err(|e| ErrorData::internal_error(e, None))?;
        Ok(ListToolsResult::with_all_items(catalog.tools.clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let catalog = catalog().map_err(|e| ErrorData::internal_error(e, None))?;
        let name = request.name.as_ref();
        if name == SCREENSHOT_TOOL {
            return Ok(screenshot(&self.app).await.into());
        }
        if !catalog.names.contains(name) {
            return Ok(failure(&format!("Unknown tool \"{name}\". Call tools/list.")).into());
        }
        let client = client_name(&context);
        let args = request.arguments.map(Value::Object).unwrap_or_else(|| json!({}));
        Ok(call_page(&self.app, name, args, &client).await.into())
    }
}

/// Nom affiché dans Slate (« Cursor remplace du texte… », confirmations). Sans session,
/// rmcp ne connaît le client que s'il l'envoie à chaque requête ; sinon il met son
/// propre nom, et c'est le User-Agent qui le donne (« Cursor/3.26 (darwin arm64) »).
fn client_name(context: &RequestContext<RoleServer>) -> String {
    let declared = context
        .peer
        .peer_info()
        .map(|info| info.client_info.name.trim().to_string())
        .filter(|name| !name.is_empty() && *name != Implementation::from_build_env().name);
    if let Some(name) = declared {
        return name;
    }
    let agent = context
        .extensions
        .get::<hyper::http::request::Parts>()
        .and_then(|parts| parts.headers.get(hyper::header::USER_AGENT))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(['/', ' ']).next())
        .unwrap_or_default();
    agent_label(agent)
}

fn agent_label(product: &str) -> String {
    match product.to_ascii_lowercase().as_str() {
        "" => "Agent".to_string(),
        "cursor" => "Cursor".to_string(),
        "claude-code" | "claude-cli" => "Claude Code".to_string(),
        "mcp-remote" => "Claude Desktop".to_string(),
        _ => product.chars().take(40).collect(),
    }
}

type HttpBody = BoxBody<Bytes, Infallible>;

fn plain(status: StatusCode, body: &'static str) -> Response<HttpBody> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())).boxed());
    *response.status_mut() = status;
    response
}

fn authorized(header: Option<&hyper::header::HeaderValue>, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let given = header.map(|value| value.as_bytes()).unwrap_or_default();
    given.len() == expected.len() && bool::from(given.ct_eq(expected.as_bytes()))
}

async fn serve(listener: tokio::net::TcpListener, app: AppHandle, token: String, cancel: CancellationToken) {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_cancellation_token(cancel.child_token());
    let handler = SlateMcp { app };
    let mcp: StreamableHttpService<SlateMcp, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(handler.clone()), Default::default(), config);
    let token = Arc::new(token);
    loop {
        let stream = tokio::select! {
            () = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(_) => continue,
            },
        };
        let mcp = mcp.clone();
        let token = token.clone();
        let service = hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
            let mut mcp = mcp.clone();
            let token = token.clone();
            async move {
                if request.uri().path() != MCP_PATH {
                    return Ok::<_, Infallible>(plain(StatusCode::NOT_FOUND, ""));
                }
                if !authorized(request.headers().get(hyper::header::AUTHORIZATION), &token) {
                    return Ok(plain(StatusCode::UNAUTHORIZED, r#"{"error":"unauthorized"}"#));
                }
                mcp.call(request).await
            }
        });
        let connection_cancel = cancel.clone();
        tokio::spawn(async move {
            let connection = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service);
            tokio::select! {
                _ = connection => {}
                () = connection_cancel.cancelled() => {}
            }
        });
    }
}

// --- État, réglage et jeton ------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Off,
    Running,
    PortInUse,
    Failed,
}

pub struct McpLocal {
    status: Status,
    port: u16,
    cancel: Option<CancellationToken>,
}

impl Default for McpLocal {
    fn default() -> Self {
        Self { status: Status::Off, port: configured_port(), cancel: None }
    }
}

#[derive(Default)]
pub struct McpLocalState(Mutex<McpLocal>);

fn configured_port() -> u16 {
    std::env::var(PORT_ENV).ok().and_then(|value| value.trim().parse().ok()).filter(|port| *port > 0).unwrap_or(DEFAULT_PORT)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    enabled: bool,
}

fn read_settings(app: &AppHandle) -> Settings {
    data_dir(app)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join(SETTINGS_FILE)).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let text = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    fs::write(data_dir(app)?.join(SETTINGS_FILE), text).map_err(|e| e.to_string())
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    fs::write(path, text).map_err(|e| e.to_string())
}

fn load_token(app: &AppHandle) -> Result<String, String> {
    let path = data_dir(app)?.join(TOKEN_FILE);
    if let Ok(saved) = fs::read_to_string(&path) {
        let saved = saved.trim();
        if saved.len() == 64 && saved.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(saved.to_string());
        }
    }
    let bytes: [u8; 32] = rand::rng().random();
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    write_private(&path, &token)?;
    Ok(token)
}

async fn start(app: AppHandle) {
    let state = app.state::<McpLocalState>();
    let port = {
        let mut current = lock(&state.0);
        if current.cancel.is_some() {
            return;
        }
        current.port = configured_port();
        current.port
    };
    let token = match load_token(&app) {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!("MCP local : jeton illisible ({error})");
            lock(&state.0).status = Status::Failed;
            return;
        }
    };
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => {
            let cancel = CancellationToken::new();
            {
                let mut current = lock(&state.0);
                current.status = Status::Running;
                current.cancel = Some(cancel.clone());
            }
            tracing::info!("MCP local sur 127.0.0.1:{port}");
            serve(listener, app.clone(), token, cancel).await;
        }
        Err(error) => {
            let in_use = error.kind() == std::io::ErrorKind::AddrInUse;
            tracing::warn!("MCP local : port {port} indisponible ({error})");
            lock(&state.0).status = if in_use { Status::PortInUse } else { Status::Failed };
        }
    }
}

fn stop(app: &AppHandle) {
    let state = app.state::<McpLocalState>();
    let mut current = lock(&state.0);
    if let Some(cancel) = current.cancel.take() {
        cancel.cancel();
    }
    current.status = Status::Off;
}

/// Au lancement : le serveur ne démarre que si l'utilisateur l'a activé.
pub fn start_if_enabled(app: &AppHandle) {
    if read_settings(app).enabled {
        tauri::async_runtime::spawn(start(app.clone()));
    }
}

#[derive(Serialize)]
pub struct StatusReport {
    enabled: bool,
    status: Status,
    port: u16,
    url: String,
    token: Option<String>,
    skill: SkillStatus,
}

fn report(app: &AppHandle) -> StatusReport {
    let enabled = read_settings(app).enabled;
    let (status, port) = {
        let state = app.state::<McpLocalState>();
        let current = lock(&state.0);
        (current.status, current.port)
    };
    StatusReport {
        enabled,
        status,
        port,
        url: format!("http://127.0.0.1:{port}{MCP_PATH}"),
        token: if enabled { load_token(app).ok() } else { None },
        skill: skill_status(),
    }
}

#[tauri::command]
pub fn mcp_local_status(app: AppHandle) -> StatusReport {
    report(&app)
}

#[tauri::command]
pub async fn mcp_local_set_enabled(app: AppHandle, enabled: bool) -> Result<StatusReport, String> {
    write_settings(&app, &Settings { enabled })?;
    if enabled {
        tauri::async_runtime::spawn(start(app.clone()));
        // Laisse au serveur le temps d'ouvrir le port (ou d'échouer) avant de répondre.
        for _ in 0..20 {
            if lock(&app.state::<McpLocalState>().0).status != Status::Off {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    } else {
        stop(&app);
    }
    Ok(report(&app))
}

// --- Skill « travailler avec Slate » ---------------------------------------

#[derive(Serialize)]
pub struct SkillStatus {
    installed: bool,
    outdated: bool,
}

fn skill_targets() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|home| vec![home.join(".cursor/skills"), home.join(".claude/skills")])
        .unwrap_or_default()
}

fn skill_status() -> SkillStatus {
    let files: Vec<Option<String>> =
        skill_targets().iter().map(|dir| fs::read_to_string(dir.join(SKILL_NAME).join("SKILL.md")).ok()).collect();
    let installed = !files.is_empty() && files.iter().all(Option::is_some);
    let outdated = files.iter().flatten().any(|text| text != SKILL);
    SkillStatus { installed: installed && !outdated, outdated }
}

/// Ce qui occupe déjà le nom du skill part dans « <dossier>-backup/slate-<date> ».
fn install_skill_into(target: &Path, stamp: &str) -> Result<(), String> {
    let destination = target.join(SKILL_NAME);
    let file = destination.join("SKILL.md");
    if fs::read_to_string(&file).is_ok_and(|text| text == SKILL) {
        return Ok(());
    }
    if fs::symlink_metadata(&destination).is_ok() {
        let parent = target.parent().ok_or("skills folder without parent")?;
        let name = target.file_name().ok_or("skills folder without name")?.to_string_lossy();
        let backup = parent.join(format!("{name}-backup")).join(format!("slate-{stamp}"));
        fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
        fs::rename(&destination, backup.join(SKILL_NAME)).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    fs::write(file, SKILL).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_local_install_skill() -> Result<SkillStatus, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs().to_string())
        .unwrap_or_default();
    let targets = skill_targets();
    if targets.is_empty() {
        return Err("No home folder available.".to_string());
    }
    for target in &targets {
        install_skill_into(target, &stamp)?;
    }
    Ok(skill_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_exposes_every_tool_with_hints_from_risk() {
        let catalog = parse_catalog(CATALOG_JSON).unwrap();
        let source: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let count = source["tools"].as_array().unwrap().len();
        assert_eq!(catalog.tools.len(), count + 1);
        let find = |name: &str| catalog.tools.iter().find(|tool| tool.name == name).unwrap();
        let read = find("read_text").annotations.clone().unwrap();
        assert_eq!(read.read_only_hint, Some(true));
        let save = find("save_document").annotations.clone().unwrap();
        assert_eq!((save.read_only_hint, save.destructive_hint), (Some(false), Some(true)));
        let replace = find("replace_text").annotations.clone().unwrap();
        assert_eq!(replace.destructive_hint, Some(false));
        assert!(catalog.instructions.contains("screenshot"));
    }

    #[test]
    fn token_check_rejects_missing_wrong_and_prefixed_values() {
        let token = "a".repeat(64);
        let good = hyper::header::HeaderValue::from_str(&format!("Bearer {token}")).unwrap();
        let wrong = hyper::header::HeaderValue::from_str(&format!("Bearer {}", "b".repeat(64))).unwrap();
        let longer = hyper::header::HeaderValue::from_str(&format!("Bearer {token}x")).unwrap();
        assert!(authorized(Some(&good), &token));
        assert!(!authorized(None, &token));
        assert!(!authorized(Some(&wrong), &token));
        assert!(!authorized(Some(&longer), &token));
    }

    #[test]
    fn agent_label_names_known_clients() {
        assert_eq!(agent_label("Cursor"), "Cursor");
        assert_eq!(agent_label("claude-code"), "Claude Code");
        assert_eq!(agent_label("mcp-remote"), "Claude Desktop");
        assert_eq!(agent_label(""), "Agent");
        assert_eq!(agent_label("Zed"), "Zed");
    }

    #[test]
    fn page_result_turns_attached_images_into_blocks() {
        let result = page_result(json!({
            "page": 1,
            "_mcpContent": [{ "type": "image", "mimeType": "image/jpeg", "data": "AAAA" }, { "type": "text" }]
        }));
        assert_eq!(result.content.len(), 2);
        assert_eq!(result.is_error, Some(false));
    }
}
