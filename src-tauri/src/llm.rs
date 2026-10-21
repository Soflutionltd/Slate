//! Chat IA intégré : configuration, clés API dans le trousseau du système,
//! détection des modèles locaux, connexion OpenRouter (OAuth PKCE) et appels
//! en streaming avec outils. Les clés ne repassent jamais par l'interface.

use base64::Engine as _;
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const KEYCHAIN_SERVICE: &str = "com.soflution.slate.ai";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);

struct Provider {
    id: &'static str,
    base_url: &'static str,
    needs_key: bool,
    anthropic: bool,
}

const PROVIDERS: &[Provider] = &[
    Provider { id: "anthropic", base_url: "https://api.anthropic.com/v1", needs_key: true, anthropic: true },
    Provider { id: "openai", base_url: "https://api.openai.com/v1", needs_key: true, anthropic: false },
    Provider { id: "openrouter", base_url: "https://openrouter.ai/api/v1", needs_key: true, anthropic: false },
    Provider {
        id: "gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        needs_key: true,
        anthropic: false,
    },
    Provider { id: "mistral", base_url: "https://api.mistral.ai/v1", needs_key: true, anthropic: false },
    Provider { id: "xai", base_url: "https://api.x.ai/v1", needs_key: true, anthropic: false },
    Provider { id: "ollama", base_url: "http://127.0.0.1:11434/v1", needs_key: false, anthropic: false },
    Provider { id: "lmstudio", base_url: "http://127.0.0.1:1234/v1", needs_key: false, anthropic: false },
    Provider { id: "custom", base_url: "", needs_key: false, anthropic: false },
    // Agent local (voir acp.rs) : `model` porte l'identifiant de l'agent.
    Provider { id: "agent", base_url: "", needs_key: false, anthropic: false },
];

fn provider(id: &str) -> Result<&'static Provider, String> {
    PROVIDERS
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("unknown_provider:{id}"))
}

/// URL d'appel : celle saisie pour un serveur local ou compatible, sinon celle du fournisseur.
fn base_url(p: &Provider, custom: &str) -> Result<String, String> {
    let custom = custom.trim().trim_end_matches('/');
    let editable = matches!(p.id, "ollama" | "lmstudio" | "custom");
    let base = if editable && !custom.is_empty() { custom } else { p.base_url };
    if base.is_empty() {
        return Err("missing_base_url".into());
    }
    Ok(base.to_string())
}

// --- Configuration et trousseau -------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct LlmConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
}

#[derive(Serialize)]
pub struct LlmState {
    #[serde(flatten)]
    pub config: LlmConfig,
    /// Fournisseurs dont une clé est enregistrée dans le trousseau.
    pub keys: Vec<String>,
}

pub(crate) fn config_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "No config directory available.".to_string())?
        .join("AltoPDF");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider_id).map_err(|e| format!("keychain: {e}"))
}

pub(crate) fn read_key(provider_id: &str) -> Result<Option<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(key) if !key.is_empty() => Ok(Some(key)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

fn store_key(provider_id: &str, key: &str) -> Result<(), String> {
    let entry = entry(provider_id)?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain: {e}")),
        };
    }
    entry.set_password(key).map_err(|e| format!("keychain: {e}"))
}

fn write_config(config: &LlmConfig) -> Result<(), String> {
    let data = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_dir()?.join("ai.json"), data).map_err(|e| e.to_string())
}

/// Ancien `llm.json` (clé API en clair) : la clé passe au trousseau, le
/// réglage dans `ai.json`, puis le fichier est supprimé.
fn migrate_legacy_config() -> Result<Option<LlmConfig>, String> {
    #[derive(Deserialize, Default)]
    struct Legacy {
        #[serde(default)]
        provider: String,
        #[serde(default)]
        api_key: String,
        #[serde(default)]
        model: String,
        #[serde(default)]
        base_url: String,
    }
    let path = config_dir()?.join("llm.json");
    if !path.exists() {
        return Ok(None);
    }
    let legacy: Legacy = serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
        .unwrap_or_default();
    let old_base = legacy.base_url.trim().trim_end_matches('/');
    let (provider_id, base) = match legacy.provider.as_str() {
        "openai" => ("openai", String::new()),
        "local" if old_base.is_empty() || old_base.contains(":11434") => ("ollama", String::new()),
        // L'ancien client ajoutait lui-même /v1/chat/completions à l'URL saisie.
        "local" => ("custom", format!("{old_base}/v1")),
        _ => ("anthropic", String::new()),
    };
    let api_key = legacy.api_key.trim();
    if !api_key.is_empty() {
        store_key(provider_id, api_key)?;
    }
    let config = LlmConfig { provider: provider_id.into(), model: legacy.model, base_url: base };
    write_config(&config)?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(Some(config))
}

#[tauri::command]
pub async fn llm_get_config() -> Result<LlmState, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let config = match migrate_legacy_config()? {
            Some(config) => config,
            None => {
                let path = config_dir()?.join("ai.json");
                if path.exists() {
                    serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?
                } else {
                    LlmConfig::default()
                }
            }
        };
        let mut keys = Vec::new();
        for p in PROVIDERS.iter().filter(|p| p.needs_key || p.id == "custom") {
            if read_key(p.id)?.is_some() {
                keys.push(p.id.to_string());
            }
        }
        Ok(LlmState { config, keys })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn llm_set_config(config: LlmConfig) -> Result<(), String> {
    provider(&config.provider)?;
    write_config(&config)
}

/// Enregistre (ou efface, si vide) la clé d'un fournisseur dans le trousseau.
#[tauri::command]
pub async fn llm_set_key(provider_id: String, key: String) -> Result<(), String> {
    provider(&provider_id)?;
    tauri::async_runtime::spawn_blocking(move || store_key(&provider_id, key.trim()))
        .await
        .map_err(|e| e.to_string())?
}

// --- Modèles disponibles et serveurs locaux -------------------------------

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10).min(timeout))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

fn authorize(req: reqwest::RequestBuilder, p: &Provider, key: Option<&str>) -> reqwest::RequestBuilder {
    let req = if p.anthropic {
        req.header("anthropic-version", "2023-06-01")
    } else if p.id == "openrouter" {
        req.header("X-Title", "Slate")
    } else {
        req
    };
    match key {
        Some(key) if p.anthropic => req.header("x-api-key", key),
        Some(key) => req.bearer_auth(key),
        None => req,
    }
}

fn required_key(p: &Provider) -> Result<Option<String>, String> {
    let key = read_key(p.id)?;
    if p.needs_key && key.is_none() {
        return Err("missing_key".into());
    }
    Ok(key)
}

async fn fetch_models(client: &reqwest::Client, p: &Provider, base: &str, key: Option<&str>) -> Result<Vec<String>, String> {
    let url = if p.anthropic { format!("{base}/models?limit=100") } else { format!("{base}/models") };
    let resp = authorize(client.get(url), p, key).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(p.id, status, &text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(body["data"]
        .as_array()
        .map(|models| models.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn llm_list_models(provider_id: String, base_url_override: String) -> Result<Vec<String>, String> {
    let p = provider(&provider_id)?;
    let base = base_url(p, &base_url_override)?;
    let key = tauri::async_runtime::spawn_blocking(move || required_key(p))
        .await
        .map_err(|e| e.to_string())??;
    fetch_models(&http_client(Duration::from_secs(20))?, p, &base, key.as_deref()).await
}

#[derive(Serialize)]
pub struct LocalServer {
    provider: &'static str,
    base_url: &'static str,
    models: Vec<String>,
}

/// Ollama (11434) et LM Studio (1234) qui tournent sur ce poste, avec leurs modèles.
#[tauri::command]
pub async fn llm_detect_local() -> Result<Vec<LocalServer>, String> {
    let client = http_client(Duration::from_millis(1200))?;
    let mut found = Vec::new();
    for p in PROVIDERS.iter().filter(|p| matches!(p.id, "ollama" | "lmstudio")) {
        if let Ok(models) = fetch_models(&client, p, p.base_url, None).await {
            found.push(LocalServer { provider: p.id, base_url: p.base_url, models });
        }
    }
    Ok(found)
}

// --- OpenRouter : OAuth PKCE avec rappel sur 127.0.0.1 ----------------------

static OAUTH_GENERATION: AtomicU64 = AtomicU64::new(0);

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

const OAUTH_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Slate</title>\
<body style=\"font:16px -apple-system,system-ui,sans-serif;background:#f4f3f0;color:#171717;display:grid;place-items:center;height:100vh;margin:0\">\
<div><h1 style=\"font-size:22px\">Slate</h1><p>OpenRouter est connecté. Tu peux fermer cet onglet.</p>\
<p style=\"color:#6b6b6b\">OpenRouter is connected. You can close this tab.</p></div>";

/// Attend `GET /callback?code=…` sur le port d'écoute ; ignore les autres requêtes.
fn wait_for_oauth_code(listener: std::net::TcpListener, generation: u64) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + OAUTH_TIMEOUT;
    while Instant::now() < deadline {
        if OAUTH_GENERATION.load(Ordering::SeqCst) != generation {
            return Err("cancelled".into());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = [0u8; 4096];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let path = request.split_whitespace().nth(1).unwrap_or("");
        let code = reqwest::Url::parse(&format!("http://127.0.0.1{path}"))
            .ok()
            .filter(|url| url.path() == "/callback")
            .and_then(|url| url.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned()));
        let Some(code) = code else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{OAUTH_PAGE}",
            OAUTH_PAGE.len()
        );
        let _ = stream.write_all(response.as_bytes());
        return Ok(code);
    }
    Err("oauth_timeout".into())
}

/// Ouvre OpenRouter dans le navigateur ; la clé créée par l'utilisateur est
/// enregistrée dans le trousseau. Un nouvel appel annule l'attente précédente.
#[tauri::command]
pub async fn llm_openrouter_connect() -> Result<(), String> {
    let generation = OAUTH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let verifier: String = rand::rng()
        .sample_iter(rand::distr::Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let auth_url = reqwest::Url::parse_with_params(
        "https://openrouter.ai/auth",
        &[
            ("callback_url", format!("http://127.0.0.1:{port}/callback")),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".into()),
            ("key_label", "Slate".into()),
        ],
    )
    .map_err(|e| e.to_string())?;
    open_in_browser(auth_url.as_str())?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_oauth_code(listener, generation))
        .await
        .map_err(|e| e.to_string())??;

    let resp = http_client(Duration::from_secs(30))?
        .post("https://openrouter.ai/api/v1/auth/keys")
        .json(&json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error("openrouter", status, &text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let key = body["key"].as_str().filter(|k| !k.is_empty()).ok_or("openrouter_no_key")?.to_string();
    tauri::async_runtime::spawn_blocking(move || store_key("openrouter", &key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn llm_openrouter_cancel() {
    OAUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
}

// --- Chat en streaming avec outils ----------------------------------------

/// Messages au format neutre de Slate :
/// `{role:"user", content}`, `{role:"assistant", content, tool_calls:[{id,name,arguments}]}`,
/// `{role:"tool", tool_call_id, name, content, is_error?, images?:[{mime_type,data}]}`.
#[derive(Deserialize)]
pub struct ChatRequest {
    request_id: String,
    provider: String,
    model: String,
    #[serde(default)]
    base_url: String,
    system: String,
    messages: Vec<Value>,
    /// `{name, description, input_schema}`
    #[serde(default)]
    tools: Vec<Value>,
}

#[derive(Serialize)]
pub struct ChatReply {
    content: String,
    tool_calls: Vec<Value>,
}

static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn is_cancelled(request_id: &str) -> bool {
    CANCELLED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .is_some_and(|set| set.contains(request_id))
}

fn forget_cancel(request_id: &str) {
    if let Some(set) = CANCELLED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
        set.remove(request_id);
    }
}

#[tauri::command]
pub fn llm_cancel(request_id: String) {
    CANCELLED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get_or_insert_with(HashSet::new)
        .insert(request_id);
}

fn api_error(provider_id: &str, status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v[0]["error"]["message"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(400).collect());
    format!("{provider_id} {}: {message}", status.as_u16())
}

fn text_of(message: &Value) -> String {
    message["content"].as_str().unwrap_or_default().to_string()
}

fn openai_messages(system: &str, messages: &[Value]) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system })];
    // Un message `tool` ne porte que du texte : les images (rendu de page)
    // suivent dans un message utilisateur, après le dernier résultat d'outil.
    let mut pending_images: Vec<Value> = Vec::new();
    for message in messages {
        let role = message["role"].as_str().unwrap_or_default();
        if role != "tool" && !pending_images.is_empty() {
            let mut content = vec![json!({ "type": "text", "text": "Images returned by the tool calls above." })];
            content.append(&mut pending_images);
            out.push(json!({ "role": "user", "content": content }));
        }
        match role {
            "assistant" => {
                let calls: Vec<Value> = message["tool_calls"]
                    .as_array()
                    .map(|calls| {
                        calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "id": call["id"],
                                    "type": "function",
                                    "function": { "name": call["name"], "arguments": call["arguments"].to_string() }
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let text = text_of(message);
                let mut entry = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) } });
                if !calls.is_empty() {
                    entry["tool_calls"] = Value::Array(calls);
                }
                out.push(entry);
            }
            "tool" => {
                out.push(json!({ "role": "tool", "tool_call_id": message["tool_call_id"], "content": text_of(message) }));
                for image in message["images"].as_array().into_iter().flatten() {
                    let url = format!(
                        "data:{};base64,{}",
                        image["mime_type"].as_str().unwrap_or("image/jpeg"),
                        image["data"].as_str().unwrap_or_default()
                    );
                    pending_images.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
            }
            _ => out.push(json!({ "role": "user", "content": text_of(message) })),
        }
    }
    if !pending_images.is_empty() {
        let mut content = vec![json!({ "type": "text", "text": "Images returned by the tool calls above." })];
        content.append(&mut pending_images);
        out.push(json!({ "role": "user", "content": content }));
    }
    out
}

fn anthropic_messages(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for message in messages {
        match message["role"].as_str().unwrap_or_default() {
            "assistant" => {
                let mut content = Vec::new();
                let text = text_of(message);
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for call in message["tool_calls"].as_array().into_iter().flatten() {
                    let input = if call["arguments"].is_object() { call["arguments"].clone() } else { json!({}) };
                    content.push(json!({ "type": "tool_use", "id": call["id"], "name": call["name"], "input": input }));
                }
                if content.is_empty() {
                    content.push(json!({ "type": "text", "text": "…" }));
                }
                out.push(json!({ "role": "assistant", "content": content }));
            }
            "tool" => {
                let mut blocks = vec![json!({ "type": "text", "text": text_of(message) })];
                for image in message["images"].as_array().into_iter().flatten() {
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image["mime_type"].as_str().unwrap_or("image/jpeg"),
                            "data": image["data"].as_str().unwrap_or_default()
                        }
                    }));
                }
                let result = json!({
                    "type": "tool_result",
                    "tool_use_id": message["tool_call_id"],
                    "content": blocks,
                    "is_error": message["is_error"].as_bool().unwrap_or(false)
                });
                // Les résultats d'un même tour vont dans un seul message utilisateur.
                let merged = out.last_mut().filter(|last| {
                    last["role"] == "user" && last["content"].as_array().is_some_and(|c| c.iter().all(|b| b["type"] == "tool_result"))
                });
                match merged {
                    Some(last) => last["content"].as_array_mut().expect("checked above").push(result),
                    None => out.push(json!({ "role": "user", "content": [result] })),
                }
            }
            _ => out.push(json!({ "role": "user", "content": text_of(message) })),
        }
    }
    out
}

/// L'endpoint compatible OpenAI de Gemini n'accepte qu'un sous-ensemble de JSON Schema.
fn gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "additionalProperties")
                .map(|(key, value)| (key.clone(), gemini_schema(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(gemini_schema).collect()),
        other => other.clone(),
    }
}

fn parse_arguments(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

/// Accumule un flux SSE et renvoie le texte et les appels d'outils complets.
struct StreamState<'a> {
    anthropic: bool,
    on_event: &'a Channel<Value>,
    content: String,
    calls: BTreeMap<u64, PartialCall>,
}

impl StreamState<'_> {
    fn push_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        let _ = self.on_event.send(json!({ "type": "text", "text": text }));
    }

    fn handle(&mut self, data: &Value) -> Result<(), String> {
        if let Some(message) = data["error"]["message"].as_str().or_else(|| data["error"].as_str()) {
            return Err(message.to_string());
        }
        if self.anthropic {
            let index = data["index"].as_u64().unwrap_or(0);
            match data["type"].as_str().unwrap_or_default() {
                "content_block_start" if data["content_block"]["type"] == "tool_use" => {
                    let block = &data["content_block"];
                    self.calls.insert(
                        index,
                        PartialCall {
                            id: block["id"].as_str().unwrap_or_default().into(),
                            name: block["name"].as_str().unwrap_or_default().into(),
                            arguments: String::new(),
                        },
                    );
                }
                "content_block_delta" => {
                    let delta = &data["delta"];
                    match delta["type"].as_str().unwrap_or_default() {
                        "text_delta" => self.push_text(delta["text"].as_str().unwrap_or_default()),
                        "input_json_delta" => {
                            if let Some(call) = self.calls.get_mut(&index) {
                                call.arguments.push_str(delta["partial_json"].as_str().unwrap_or_default());
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
            return Ok(());
        }
        let delta = &data["choices"][0]["delta"];
        if let Some(text) = delta["content"].as_str() {
            self.push_text(text);
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            // Gemini envoie chaque appel complet, sans `index` : un `id` neuf = un appel neuf.
            let index = match call["index"].as_u64() {
                Some(index) => index,
                None => {
                    let id = call["id"].as_str().unwrap_or_default();
                    self.calls
                        .iter()
                        .find(|(_, c)| !id.is_empty() && c.id == id)
                        .map(|(i, _)| *i)
                        .unwrap_or(self.calls.len() as u64)
                }
            };
            let partial = self.calls.entry(index).or_default();
            if let Some(id) = call["id"].as_str().filter(|id| !id.is_empty()) {
                partial.id = id.into();
            }
            if let Some(name) = call["function"]["name"].as_str().filter(|n| !n.is_empty()) {
                partial.name = name.into();
            }
            match &call["function"]["arguments"] {
                Value::String(chunk) => partial.arguments.push_str(chunk),
                Value::Object(object) => partial.arguments = Value::Object(object.clone()).to_string(),
                _ => {}
            }
        }
        Ok(())
    }

    fn finish(self) -> ChatReply {
        let tool_calls = self
            .calls
            .into_values()
            .filter(|call| !call.name.is_empty())
            .enumerate()
            .map(|(i, call)| {
                let id = if call.id.is_empty() { format!("call_{i}") } else { call.id };
                json!({ "id": id, "name": call.name, "arguments": parse_arguments(&call.arguments) })
            })
            .collect();
        ChatReply { content: self.content, tool_calls }
    }
}

#[tauri::command]
pub async fn llm_chat(request: ChatRequest, on_event: Channel<Value>) -> Result<ChatReply, String> {
    let request_id = request.request_id.clone();
    let result = run_chat(request, &on_event).await;
    forget_cancel(&request_id);
    result
}

async fn run_chat(request: ChatRequest, on_event: &Channel<Value>) -> Result<ChatReply, String> {
    let p = provider(&request.provider)?;
    let base = base_url(p, &request.base_url)?;
    if request.model.trim().is_empty() {
        return Err("missing_model".into());
    }
    let key = tauri::async_runtime::spawn_blocking(move || required_key(p))
        .await
        .map_err(|e| e.to_string())??;

    let (url, body) = if p.anthropic {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|t| json!({ "name": t["name"], "description": t["description"], "input_schema": t["input_schema"] }))
            .collect();
        let mut body = json!({
            "model": request.model,
            "max_tokens": 8192,
            "system": request.system,
            "messages": anthropic_messages(&request.messages),
            "stream": true
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }
        (format!("{base}/messages"), body)
    } else {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|t| {
                let parameters = if p.id == "gemini" { gemini_schema(&t["input_schema"]) } else { t["input_schema"].clone() };
                json!({
                    "type": "function",
                    "function": { "name": t["name"], "description": t["description"], "parameters": parameters }
                })
            })
            .collect();
        let mut body = Map::new();
        body.insert("model".into(), json!(request.model));
        body.insert("messages".into(), Value::Array(openai_messages(&request.system, &request.messages)));
        body.insert("stream".into(), json!(true));
        if !tools.is_empty() {
            body.insert("tools".into(), Value::Array(tools));
        }
        (format!("{base}/chat/completions"), Value::Object(body))
    };

    let client = http_client(Duration::from_secs(600))?;
    let mut resp = authorize(client.post(url), p, key.as_deref())
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(p.id, status, &text));
    }

    let mut state = StreamState { anthropic: p.anthropic, on_event, content: String::new(), calls: BTreeMap::new() };
    let mut pending: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if is_cancelled(&request.request_id) {
            return Err("cancelled".into());
        }
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                state.handle(&value)?;
            }
        }
    }
    Ok(state.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn_with_two_tools() -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": "Tourne la page 2" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [
                { "id": "a", "name": "render_page", "arguments": { "page": 2 } },
                { "id": "b", "name": "rotate_pages", "arguments": { "pages": [2], "degrees": 90 } }
            ] }),
            json!({ "role": "tool", "tool_call_id": "a", "name": "render_page", "content": "{}",
                    "images": [{ "mime_type": "image/jpeg", "data": "AAAA" }] }),
            json!({ "role": "tool", "tool_call_id": "b", "name": "rotate_pages", "content": "{}" }),
        ]
    }

    #[test]
    fn anthropic_merges_tool_results_into_one_user_turn() {
        let out = anthropic_messages(&turn_with_two_tools());
        assert_eq!(out.len(), 3);
        assert_eq!(out[1]["content"][0]["type"], "tool_use");
        assert_eq!(out[1]["content"][0]["input"]["page"], 2);
        let results = out[2]["content"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["content"][1]["type"], "image");
        assert_eq!(results[1]["tool_use_id"], "b");
    }

    #[test]
    fn openai_moves_images_after_the_tool_messages() {
        let out = openai_messages("sys", &turn_with_two_tools());
        let roles: Vec<&str> = out.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool", "tool", "user"]);
        assert_eq!(out[2]["content"], Value::Null);
        assert_eq!(out[2]["tool_calls"][1]["function"]["arguments"], r#"{"degrees":90,"pages":[2]}"#);
        assert_eq!(out[5]["content"][1]["image_url"]["url"], "data:image/jpeg;base64,AAAA");
    }

    #[test]
    fn gemini_schema_drops_additional_properties_everywhere() {
        let schema = json!({ "type": "object", "additionalProperties": false,
            "properties": { "values": { "type": "object", "additionalProperties": { "type": "string" } } } });
        assert!(!gemini_schema(&schema).to_string().contains("additionalProperties"));
    }

    #[test]
    fn arguments_fall_back_to_raw_text() {
        assert_eq!(parse_arguments(""), json!({}));
        assert_eq!(parse_arguments(r#"{"page":1}"#), json!({ "page": 1 }));
        assert_eq!(parse_arguments("{oops"), json!("{oops"));
    }
}
