use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct LlmConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
}

fn config_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "No config directory available.".to_string())?
        .join("AltoPDF");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("llm.json"))
}

#[tauri::command]
pub fn llm_get_config() -> Result<LlmConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(LlmConfig::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn llm_set_config(config: LlmConfig) -> Result<(), String> {
    let path = config_path()?;
    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn llm_chat(
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    if provider == "claude" {
        let base = if base_url.trim().is_empty() {
            "https://api.anthropic.com".to_string()
        } else {
            base_url.trim_end_matches('/').to_string()
        };
        let url = format!("{}/v1/messages", base);
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect();
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 4096,
            "system": system,
            "messages": msgs
        });
        let resp = client
            .post(url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Claude API {}: {}", status, text));
        }
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let out = v["content"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        return Ok(out);
    }

    // openai or local (OpenAI-compatible)
    let default_base = if provider == "openai" {
        "https://api.openai.com"
    } else {
        "http://localhost:11434"
    };
    let base = if base_url.trim().is_empty() {
        default_base.to_string()
    } else {
        base_url.trim_end_matches('/').to_string()
    };
    let url = format!("{}/v1/chat/completions", base);
    let mut msgs: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    for m in &messages {
        msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }
    let body = serde_json::json!({
        "model": model,
        "messages": msgs,
        "temperature": 0.2
    });
    let mut req = client.post(url).header("content-type", "application/json");
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("LLM API {}: {}", status, text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let out = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    Ok(out)
}
