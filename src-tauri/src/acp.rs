//! Agents locaux pilotés par l'Agent Client Protocol (ACP, JSON-RPC sur stdio) :
//! Claude Code, Codex et Gemini CLI, lancés par npx depuis leurs adaptateurs
//! officiels. Slate leur prête ses outils par un serveur MCP HTTP local
//! (127.0.0.1, jeton aléatoire) et relaie la conversation vers le chat.
//!
//! Anthropic et Google interdisent aux applications tierces d'utiliser la
//! connexion claude.ai ou Google de leur CLI : Claude et Gemini tournent avec la
//! clé API du trousseau, dans un dossier de configuration propre à Slate. Codex
//! peut utiliser la connexion ChatGPT faite par l'utilisateur dans son terminal.
//! Slate ne lit jamais les identifiants d'un CLI.

use rand::Rng as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;
use tauri::ipc::Channel;

use crate::llm;

/// Le premier lancement télécharge l'adaptateur par npx.
const START_TIMEOUT: Duration = Duration::from_secs(240);
const SESSION_TIMEOUT: Duration = Duration::from_secs(90);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Confirmations et outils qui attendent une réponse dans Slate.
const USER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_HTTP_BODY: usize = 8 * 1024 * 1024;
const MCP_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

#[cfg(windows)]
const NPX: &str = "npx.cmd";
#[cfg(not(windows))]
const NPX: &str = "npx";

struct AgentDef {
    id: &'static str,
    package: &'static str,
    args: &'static [&'static str],
    key_provider: &'static str,
    key_env: &'static str,
    key_required: bool,
    /// Variable qui place la configuration du CLI dans le dossier de Slate,
    /// appliquée dès qu'une clé est fournie : la clé n'arrive jamais dans la
    /// configuration personnelle du CLI. Sans clé, Codex garde son `codex login`.
    config_env: Option<&'static str>,
    /// Variables qui feraient utiliser un autre compte que la clé du trousseau.
    strip_env: &'static [&'static str],
}

const AGENTS: &[AgentDef] = &[
    AgentDef {
        id: "claude",
        package: "@agentclientprotocol/claude-agent-acp@0.88.0",
        args: &[],
        key_provider: "anthropic",
        key_env: "ANTHROPIC_API_KEY",
        key_required: true,
        config_env: Some("CLAUDE_CONFIG_DIR"),
        strip_env: &[
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        ],
    },
    AgentDef {
        id: "codex",
        package: "@agentclientprotocol/codex-acp@2.1.1",
        args: &[],
        key_provider: "openai",
        key_env: "OPENAI_API_KEY",
        key_required: false,
        config_env: Some("CODEX_HOME"),
        strip_env: &[],
    },
    AgentDef {
        id: "gemini",
        package: "@google/gemini-cli@0.63.0",
        args: &["--acp"],
        key_provider: "gemini",
        key_env: "GEMINI_API_KEY",
        key_required: true,
        config_env: Some("GEMINI_CLI_HOME"),
        strip_env: &[
            "GOOGLE_API_KEY",
            "GOOGLE_GENAI_USE_GCA",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_CLOUD_ACCESS_TOKEN",
        ],
    },
];

fn agent(id: &str) -> Result<&'static AgentDef, String> {
    AGENTS.iter().find(|a| a.id == id).ok_or_else(|| format!("unknown_agent:{id}"))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn random_token(len: usize) -> String {
    rand::rng().sample_iter(rand::distr::Alphanumeric).take(len).map(char::from).collect()
}

// --- Node.js : le PATH du shell de connexion ------------------------------

/// Une app lancée depuis le Finder n'hérite pas du PATH du terminal (nvm,
/// Homebrew…) : on le demande une fois au shell de connexion.
fn search_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        #[cfg(unix)]
        {
            let mut parts: Vec<String> = Vec::new();
            if let Some(login) = login_shell_path() {
                parts.push(login);
            }
            parts.push(current);
            parts.push("/opt/homebrew/bin:/usr/local/bin".into());
            parts.retain(|p| !p.is_empty());
            parts.join(":")
        }
        #[cfg(not(unix))]
        current
    })
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '\\n__SLATE_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(5)).ok();
    let _ = child.kill();
    let _ = child.wait();
    out?.lines()
        .find_map(|line| line.strip_prefix("__SLATE_PATH__"))
        .map(str::to_string)
        .filter(|p| !p.is_empty())
}

fn find_program(name: &str) -> Option<PathBuf> {
    std::env::split_paths(search_path()).map(|dir| dir.join(name)).find(|path| path.is_file())
}

fn agents_dir(sub: &str) -> Result<PathBuf, String> {
    let dir = llm::config_dir()?.join("agents").join(sub);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Le dossier de Gemini propre à Slate impose la clé API comme méthode de connexion
/// et approuve le seul dossier de travail : ailleurs, Gemini ignore les serveurs MCP.
/// Renvoie le fichier des dossiers approuvés.
fn prepare_gemini_home(home: &Path, workspace: &Path) -> Result<PathBuf, String> {
    let dir = home.join(".gemini");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let mut settings: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    settings["security"] = json!({ "auth": { "selectedType": "gemini-api-key" } });
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    let trusted = dir.join("trustedFolders.json");
    let rules = json!({ workspace.to_string_lossy(): "TRUST_FOLDER" });
    fs::write(&trusted, rules.to_string()).map_err(|e| e.to_string())?;
    Ok(trusted)
}

// --- Événements vers l'interface et réponses de l'utilisateur -------------

/// Canal du message en cours : mises à jour de l'agent, appels d'outils Slate, confirmations.
static EVENTS: Mutex<Option<Channel<Value>>> = Mutex::new(None);
static WAITING: Mutex<Option<HashMap<String, mpsc::Sender<Value>>>> = Mutex::new(None);

fn emit(event: Value) -> bool {
    lock(&EVENTS).as_ref().is_some_and(|channel| channel.send(event).is_ok())
}

/// Envoie une demande à l'interface et attend `acp_reply`. `None` : pas de
/// message en cours, arrêt demandé ou délai dépassé.
fn ask_user(kind: &str, mut payload: Value) -> Option<Value> {
    let id = random_token(16);
    let (tx, rx) = mpsc::channel();
    lock(&WAITING).get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    payload["type"] = json!(kind);
    payload["id"] = json!(id);
    let answer = if emit(payload) { rx.recv_timeout(USER_TIMEOUT).ok() } else { None };
    if let Some(waiting) = lock(&WAITING).as_mut() {
        waiting.remove(&id);
    }
    answer
}

/// Libère toutes les attentes : les confirmations repartent « annulées ».
fn release_waiting() {
    lock(&WAITING).take();
}

#[tauri::command]
pub fn acp_reply(id: String, answer: Value) {
    if let Some(tx) = lock(&WAITING).as_mut().and_then(|waiting| waiting.remove(&id)) {
        let _ = tx.send(answer);
    }
}

// --- Serveur MCP local : les outils de Slate pour l'agent -----------------

struct McpServer {
    port: u16,
    token: String,
}

static MCP_SERVER: OnceLock<McpServer> = OnceLock::new();
/// Catalogue `ai-tools.json` transmis par l'interface au démarrage de l'agent.
static TOOLS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

fn mcp_server() -> Result<&'static McpServer, String> {
    if let Some(server) = MCP_SERVER.get() {
        return Ok(server);
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = MCP_SERVER.get_or_init(|| McpServer { port, token: random_token(40) });
    if server.port == port {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || serve_mcp(stream));
            }
        });
    }
    Ok(server)
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &TcpStream) -> Option<HttpRequest> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.split('?').next()?.to_string();
    let mut headers = HashMap::new();
    for _ in 0..100 {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if length > MAX_HTTP_BODY {
        return None;
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(HttpRequest { method, path, headers, body })
}

fn write_http(stream: &mut TcpStream, status: &str, extra: &str, body: &[u8]) {
    let content_type = if body.is_empty() { "" } else { "Content-Type: application/json\r\n" };
    let head = format!(
        "HTTP/1.1 {status}\r\n{content_type}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body));
}

fn serve_mcp(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(request) = read_http_request(&stream) else { return };
    let Some(server) = MCP_SERVER.get() else { return };
    if request.path != "/mcp" {
        return write_http(&mut stream, "404 Not Found", "", b"");
    }
    // Un navigateur envoie toujours Origin : on refuse les pages web (rebinding DNS).
    if request.headers.contains_key("origin") {
        return write_http(&mut stream, "403 Forbidden", "", b"");
    }
    let expected = format!("Bearer {}", server.token);
    let given = request.headers.get("authorization").map(String::as_bytes).unwrap_or_default();
    if given.len() != expected.len() || !bool::from(subtle::ConstantTimeEq::ct_eq(given, expected.as_bytes())) {
        return write_http(&mut stream, "401 Unauthorized", "", b"");
    }
    if request.method != "POST" {
        return write_http(&mut stream, "405 Method Not Allowed", "Allow: POST\r\n", b"");
    }
    let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
        let body = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } });
        return write_http(&mut stream, "400 Bad Request", "", body.to_string().as_bytes());
    };
    let (Some(id), Some(method)) = (message.get("id"), message.get("method").and_then(Value::as_str)) else {
        return write_http(&mut stream, "202 Accepted", "", b"");
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let body = match handle_mcp(method, &params) {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, text)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } }),
    };
    write_http(&mut stream, "200 OK", "", body.to_string().as_bytes());
}

fn handle_mcp(method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or_default();
            let version = MCP_VERSIONS.iter().find(|v| **v == requested).copied().unwrap_or(MCP_VERSIONS[1]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "slate", "version": env!("CARGO_PKG_VERSION") }
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => {
            let tools: Vec<Value> = lock(&TOOLS)
                .iter()
                .map(|tool| {
                    let risk = tool["risk"].as_str().unwrap_or("edit");
                    json!({
                        "name": tool["name"],
                        "description": tool["description"],
                        "inputSchema": tool["input_schema"],
                        "annotations": { "readOnlyHint": risk == "read", "destructiveHint": risk == "destructive" }
                    })
                })
                .collect();
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default().to_string();
            if !lock(&TOOLS).iter().any(|tool| tool["name"] == name.as_str()) {
                return Ok(tool_error(&format!("Unknown tool \"{name}\".")));
            }
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match ask_user("tool", json!({ "name": name, "arguments": arguments })) {
                Some(answer) if answer["content"].is_array() => Ok(answer),
                _ => Ok(tool_error("Slate stopped this request.")),
            }
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn tool_error(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

// --- Connexion ACP ---------------------------------------------------------

struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    /// Gemini renvoie l'erreur de Google en JSON imbriqué dans `message`, souvent sur deux niveaux.
    fn readable(&self) -> String {
        let mut message = self.message.clone();
        while let Some(inner) = serde_json::from_str::<Value>(&message)
            .ok()
            .and_then(|value| value.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        {
            message = inner;
        }
        message
    }

    fn into_prompt_error(self) -> String {
        let message = self.readable();
        let rejected_key = matches!(self.code, -32000 | 401 | 403) || message.contains("API key");
        if rejected_key { format!("agent_auth:{message}") } else { message }
    }
}

struct Connection {
    def: &'static AgentDef,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, RpcError>>>>,
    next_id: AtomicU64,
    stderr_tail: Mutex<VecDeque<String>>,
    session_id: Mutex<Option<String>>,
    info: Mutex<Value>,
}

static CURRENT: Mutex<Option<Arc<Connection>>> = Mutex::new(None);

impl Connection {
    fn send(&self, message: &Value) -> Result<(), String> {
        let mut guard = lock(&self.stdin);
        let stdin = guard.as_mut().ok_or_else(|| self.exit_message())?;
        let mut line = message.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|_| self.exit_message())
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(message) = self.send(&message) {
            lock(&self.pending).remove(&id);
            return Err(RpcError { code: -1, message });
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                Err(RpcError { code: -1, message: "agent_timeout".into() })
            }
            Err(RecvTimeoutError::Disconnected) => Err(RpcError { code: -1, message: self.exit_message() }),
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn respond(&self, id: Value, result: Result<Value, (i64, &str)>) {
        let message = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, text)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } }),
        };
        let _ = self.send(&message);
    }

    /// `agent_exited`, suivi des dernières lignes d'erreur de l'agent.
    fn exit_message(&self) -> String {
        let tail: Vec<String> = lock(&self.stderr_tail).iter().cloned().collect();
        if tail.is_empty() {
            "agent_exited".into()
        } else {
            format!("agent_exited:{}", tail.join("\n"))
        }
    }

    fn alive(&self) -> bool {
        lock(&self.stdin).is_some() && lock(&self.session_id).is_some()
    }
}

fn read_agent(conn: Arc<Connection>, stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let method = message.get("method").and_then(Value::as_str);
        match (method, message.get("id")) {
            (None, Some(id)) => {
                let Some(tx) = id.as_u64().and_then(|id| lock(&conn.pending).remove(&id)) else { continue };
                let result = match message.get("error") {
                    Some(error) => Err(RpcError {
                        code: error["code"].as_i64().unwrap_or(-1),
                        message: error["message"].as_str().unwrap_or("Agent error").to_string(),
                    }),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
            (Some(method), Some(id)) => {
                let conn = conn.clone();
                let id = id.clone();
                let method = method.to_string();
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                std::thread::spawn(move || handle_agent_request(&conn, id, &method, &params));
            }
            (Some("session/update"), None) => {
                if let Some(update) = message.pointer("/params/update") {
                    emit(json!({ "type": "update", "update": update }));
                }
            }
            _ => {}
        }
    }
    lock(&conn.stdin).take();
    lock(&conn.pending).clear();
}

/// Slate n'offre ni fichiers ni terminal à l'agent : seules les confirmations passent.
fn handle_agent_request(conn: &Connection, id: Value, method: &str, params: &Value) {
    if method != "session/request_permission" {
        return conn.respond(id, Err((-32601, "Slate does not provide this capability.")));
    }
    let payload = json!({ "toolCall": params["toolCall"], "options": params["options"] });
    let outcome = match ask_user("permission", payload) {
        Some(Value::String(option_id)) => json!({ "outcome": "selected", "optionId": option_id }),
        _ => json!({ "outcome": "cancelled" }),
    };
    conn.respond(id, Ok(json!({ "outcome": outcome })));
}

fn current() -> Option<Arc<Connection>> {
    lock(&CURRENT).clone()
}

fn disconnect() {
    if let Some(conn) = lock(&CURRENT).take() {
        // Fermer stdin suffit à arrêter l'adaptateur lancé par npx.
        lock(&conn.stdin).take();
        let mut child = lock(&conn.child);
        let _ = child.kill();
        let _ = child.wait();
    }
    release_waiting();
}

fn api_key_method(init: &Value, def: &AgentDef) -> Option<String> {
    let ids: Vec<&str> = init["authMethods"]
        .as_array()?
        .iter()
        .filter_map(|method| method["id"].as_str())
        .filter(|id| {
            let id = id.to_ascii_lowercase();
            id.contains("api-key") || id.contains("api_key") || id.contains("apikey")
        })
        .collect();
    ids.iter()
        .find(|id| id.to_ascii_lowercase().contains(def.key_provider))
        .or_else(|| ids.first())
        .map(|id| id.to_string())
}

fn open_session(conn: &Connection, init: &Value, key: Option<&str>, cwd: &Path) -> Result<String, String> {
    let server = mcp_server()?;
    let mut params = json!({
        "cwd": cwd,
        "mcpServers": [{
            "type": "http",
            "name": "slate",
            "url": format!("http://127.0.0.1:{}/mcp", server.port),
            "headers": [{ "name": "Authorization", "value": format!("Bearer {}", server.token) }]
        }]
    });
    if conn.def.id == "claude" {
        // Ni shell ni fichiers : Claude Code ne travaille qu'avec les outils de Slate.
        params["_meta"] = json!({
            "claudeCode": { "options": { "tools": [], "allowedTools": ["mcp__slate__*"], "settingSources": [] } }
        });
    }
    let session_id = |result: Value| {
        result["sessionId"].as_str().map(str::to_string).ok_or_else(|| "agent_bad_session".to_string())
    };
    match conn.request("session/new", params.clone(), SESSION_TIMEOUT) {
        Ok(result) => session_id(result),
        Err(error) if error.code == -32000 => {
            let (Some(key), Some(method)) = (key, api_key_method(init, conn.def)) else {
                return Err(format!("agent_auth:{}", error.readable()));
            };
            let mut auth = json!({ "methodId": method });
            if conn.def.id == "gemini" {
                auth["_meta"] = json!({ "api-key": key });
            }
            conn.request("authenticate", auth, SESSION_TIMEOUT)
                .map_err(|e| format!("agent_auth:{}", e.readable()))?;
            conn.request("session/new", params, SESSION_TIMEOUT)
                .map_err(|e| format!("agent_auth:{}", e.readable()))
                .and_then(session_id)
        }
        Err(error) => Err(error.readable()),
    }
}

fn spawn_agent(def: &'static AgentDef, key: Option<&str>, workspace: &Path) -> Result<Arc<Connection>, String> {
    let npx = find_program(NPX).ok_or("node_missing")?;
    let mut command = Command::new(npx);
    command
        .arg("-y")
        .arg(def.package)
        .args(def.args)
        .current_dir(workspace)
        .env("PATH", search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in def.strip_env {
        command.env_remove(name);
    }
    if let Some(name) = def.config_env.filter(|_| key.is_some()) {
        let home = agents_dir(def.id)?;
        if def.id == "gemini" {
            command.env("GEMINI_CLI_TRUSTED_FOLDERS_PATH", prepare_gemini_home(&home, workspace)?);
        }
        command.env(name, home);
    }
    if let Some(key) = key {
        command.env(def.key_env, key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| format!("agent_spawn:{e}"))?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Err("agent_spawn:stdio".into());
    };
    let conn = Arc::new(Connection {
        def,
        child: Mutex::new(child),
        stdin: Mutex::new(Some(stdin)),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
        stderr_tail: Mutex::new(VecDeque::new()),
        session_id: Mutex::new(None),
        info: Mutex::new(Value::Null),
    });
    let reader = conn.clone();
    std::thread::spawn(move || read_agent(reader, stdout));
    let logs = conn.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut tail = lock(&logs.stderr_tail);
            tail.push_back(line.chars().take(400).collect());
            while tail.len() > 6 {
                tail.pop_front();
            }
        }
    });
    Ok(conn)
}

fn connect(agent_id: &str, on_step: &Channel<Value>) -> Result<Value, String> {
    let def = agent(agent_id)?;
    if let Some(conn) = current().filter(|conn| conn.def.id == def.id && conn.alive()) {
        return Ok(lock(&conn.info).clone());
    }
    disconnect();
    let key = llm::read_key(def.key_provider)?;
    if def.key_required && key.is_none() {
        return Err(format!("missing_agent_key:{}", def.key_provider));
    }
    let workspace = agents_dir("workspace")?;
    let conn = spawn_agent(def, key.as_deref(), &workspace)?;
    *lock(&CURRENT) = Some(conn.clone());

    let started = (|| -> Result<Value, String> {
        let init = conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "slate", "title": "Slate", "version": env!("CARGO_PKG_VERSION") }
                }),
                START_TIMEOUT,
            )
            .map_err(|e| e.message)?;
        if init.pointer("/agentCapabilities/mcpCapabilities/http").and_then(Value::as_bool) != Some(true) {
            return Err("agent_no_http_mcp".to_string());
        }
        let _ = on_step.send(json!({ "step": "installed" }));
        let session = open_session(&conn, &init, key.as_deref(), &workspace)?;
        *lock(&conn.session_id) = Some(session.clone());
        let info = json!({
            "name": init.pointer("/agentInfo/title").or_else(|| init.pointer("/agentInfo/name")),
            "version": init.pointer("/agentInfo/version"),
            "session": session
        });
        *lock(&conn.info) = info.clone();
        let _ = on_step.send(json!({ "step": "connected" }));
        Ok(info)
    })();
    if started.is_err() {
        disconnect();
    }
    started
}

// --- Commandes ------------------------------------------------------------

#[derive(Serialize)]
pub struct AgentStatus {
    id: &'static str,
    node: bool,
    key: bool,
    key_required: bool,
    connected: bool,
}

/// État de chaque agent : Node.js présent, clé dans le trousseau, session ouverte.
#[tauri::command]
pub async fn acp_agents() -> Result<Vec<AgentStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<AgentStatus>, String> {
        let node = find_program(NPX).is_some();
        let connected = current().filter(|conn| conn.alive()).map(|conn| conn.def.id);
        AGENTS
            .iter()
            .map(|def| {
                Ok(AgentStatus {
                    id: def.id,
                    node,
                    key: llm::read_key(def.key_provider)?.is_some(),
                    key_required: def.key_required,
                    connected: connected == Some(def.id),
                })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lance l'agent et ouvre une session avec les outils de Slate. `on_step`
/// signale `installed` (l'agent répond) puis `connected` (session ouverte).
#[tauri::command]
pub async fn acp_connect(agent_id: String, tools: Vec<Value>, on_step: Channel<Value>) -> Result<Value, String> {
    *lock(&TOOLS) = tools;
    tauri::async_runtime::spawn_blocking(move || connect(&agent_id, &on_step))
        .await
        .map_err(|e| e.to_string())?
}

/// Envoie un message à l'agent. Les mises à jour, appels d'outils et
/// confirmations arrivent sur `on_event` ; l'interface répond par `acp_reply`.
#[tauri::command]
pub async fn acp_prompt(text: String, on_event: Channel<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let conn = current().filter(|conn| conn.alive()).ok_or("agent_not_connected")?;
        let session = lock(&conn.session_id).clone().ok_or("agent_not_connected")?;
        *lock(&EVENTS) = Some(on_event);
        let result = conn.request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }),
            PROMPT_TIMEOUT,
        );
        lock(&EVENTS).take();
        release_waiting();
        // Claude Code et Gemini ouvrent la session sans vérifier la clé : le refus arrive au premier message.
        let result = result.map_err(RpcError::into_prompt_error)?;
        Ok(json!({ "stop_reason": result["stopReason"] }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn acp_cancel() {
    if let Some(conn) = current() {
        if let Some(session) = lock(&conn.session_id).clone() {
            let _ = conn.notify("session/cancel", json!({ "sessionId": session }));
        }
    }
    release_waiting();
}

#[tauri::command]
pub async fn acp_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(disconnect).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_api_key_method_of_the_agent() {
        let init = json!({ "authMethods": [
            { "id": "chatgpt" }, { "id": "codex-api-key" }, { "id": "openai-api-key" }
        ] });
        assert_eq!(api_key_method(&init, agent("codex").unwrap()).as_deref(), Some("openai-api-key"));
        let gemini = json!({ "authMethods": [{ "id": "oauth-personal" }, { "id": "gemini-api-key" }] });
        assert_eq!(api_key_method(&gemini, agent("gemini").unwrap()).as_deref(), Some("gemini-api-key"));
        let login_only = json!({ "authMethods": [{ "id": "claude-login" }] });
        assert_eq!(api_key_method(&login_only, agent("claude").unwrap()), None);
    }

    #[test]
    fn mcp_server_negotiates_a_known_version() {
        let result = handle_mcp("initialize", &json!({ "protocolVersion": "2025-03-26" })).ok().unwrap();
        assert_eq!(result["protocolVersion"], "2025-03-26");
        let fallback = handle_mcp("initialize", &json!({ "protocolVersion": "1999-01-01" })).ok().unwrap();
        assert_eq!(fallback["protocolVersion"], MCP_VERSIONS[1]);
        assert!(handle_mcp("resources/list", &json!({})).is_err());
    }

    #[test]
    fn unknown_tools_are_refused_without_asking_slate() {
        let result = handle_mcp("tools/call", &json!({ "name": "rm_rf", "arguments": {} })).ok().unwrap();
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn unwraps_the_rejected_gemini_key() {
        let google = json!({ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key." } });
        let wrapped = json!({ "error": { "message": google.to_string() } });
        let error = RpcError { code: 400, message: wrapped.to_string() };
        assert_eq!(error.into_prompt_error(), "agent_auth:API key not valid. Please pass a valid API key.");
        let other = RpcError { code: -32603, message: "Internal error".into() };
        assert_eq!(other.into_prompt_error(), "Internal error");
    }
}
