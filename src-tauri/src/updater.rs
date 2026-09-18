use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

/// Premier check natif : légèrement après le boot JS (3,5 s) pour éviter un double fetch.
const BACKGROUND_CHECK_INITIAL_DELAY: Duration = Duration::from_secs(4);
/// Intervalle du poll Rust — indépendant du WebView (timers JS gelés hors focus).
const BACKGROUND_CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// Doit rester synchronisée avec `plugins.updater.endpoints` dans `tauri.conf.json`.
const UPDATE_MANIFEST_URL: &str =
    "https://github.com/Soflutionltd/Slate/releases/latest/download/latest.json";

/// Construit un updater qui contourne le cache CDN de GitHub.
///
/// GitHub met en cache la redirection `releases/latest/download/latest.json`
/// pendant plusieurs minutes : juste après une publication, un utilisateur pouvait
/// se voir proposer (et installer) l'avant-dernière version au lieu de la dernière.
/// Un paramètre de requête unique par appel + les en-têtes `no-cache` garantissent
/// une résolution fraîche du manifest à chaque vérification.
fn fresh_updater(app: &AppHandle) -> Result<Updater, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let url = Url::parse(&format!("{UPDATE_MANIFEST_URL}?ts={ts}")).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Cache-Control", "no-cache")
        .map_err(|e| e.to_string())?
        .header("Pragma", "no-cache")
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// Métadonnées d'une mise à jour disponible, renvoyées au frontend pour alimenter
/// le pop-up « Une nouvelle version est disponible ».
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

/// Progression du téléchargement émise vers le frontend (événement `slate-update-progress`).
#[derive(Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

async fn probe_update(app: &AppHandle) -> Option<UpdateInfo> {
    let updater = match fresh_updater(app) {
        Ok(updater) => updater,
        Err(err) => {
            tracing::warn!("Slate updater init failed: {err}");
            return None;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => Some(UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        }),
        Ok(None) => None,
        Err(err) => {
            tracing::warn!("Slate update check failed: {err}");
            None
        }
    }
}

/// Vérifie auprès des GitHub Releases si une version plus récente et signée existe.
///
/// Appelé au démarrage par le frontend (non bloquant). Renvoie `None` si l'app est
/// à jour, ou si le réseau est indisponible — un échec de vérification ne doit jamais
/// gêner l'utilisateur.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(probe_update(&app).await)
}

/// Poll natif : survit au gel des timers WKWebView dès que la fenêtre n'est plus au focus.
/// Émet `slate-update-available` — le frontend affiche le toast.
pub fn start_background_checks(app: AppHandle) {
    std::thread::Builder::new()
        .name("slate-updater".into())
        .spawn(move || {
            std::thread::sleep(BACKGROUND_CHECK_INITIAL_DELAY);
            loop {
                let handle = app.clone();
                if let Some(info) = tauri::async_runtime::block_on(probe_update(&handle)) {
                    if let Err(err) = handle.emit("slate-update-available", &info) {
                        tracing::warn!("Slate update event emit failed: {err}");
                    }
                }
                std::thread::sleep(BACKGROUND_CHECK_INTERVAL);
            }
        })
        .ok();
}

/// Télécharge + installe la mise à jour signée, puis redémarre l'application.
///
/// Déclenché quand l'utilisateur clique sur « Mettre à jour » dans le pop-up.
/// La signature est vérifiée par le plugin avant l'installation ; en cas d'échec,
/// rien n'est installé. `app.restart()` ne retourne jamais (relance le process).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    // Re-vérification fraîche au moment du clic : si une version encore plus récente
    // que celle affichée dans le pop-up vient de sortir, c'est elle qu'on installe.
    let updater = fresh_updater(&app)?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("Aucune mise à jour disponible".to_string());
    };

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;

    update
        .download_and_install(
            move |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                let _ = progress_app.emit(
                    "slate-update-progress",
                    UpdateProgress {
                        downloaded,
                        total: content_len,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Err(err) = crate::write_update_relaunch_flag(&app) {
        tracing::warn!("Slate update relaunch flag failed: {err}");
    }

    tracing::info!("Slate update installed — restarting");
    app.restart();
}
