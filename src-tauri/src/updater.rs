use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

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

/// Vérifie auprès des GitHub Releases si une version plus récente et signée existe.
///
/// Appelé au démarrage par le frontend (non bloquant). Renvoie `None` si l'app est
/// à jour, ou si le réseau est indisponible — un échec de vérification ne doit jamais
/// gêner l'utilisateur.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(err) => {
            // Réseau coupé, endpoint inaccessible… : on log et on reste silencieux.
            tracing::debug!("Slate update check failed: {err}");
            Ok(None)
        }
    }
}

/// Télécharge + installe la mise à jour signée, puis redémarre l'application.
///
/// Déclenché quand l'utilisateur clique sur « Mettre à jour » dans le pop-up.
/// La signature est vérifiée par le plugin avant l'installation ; en cas d'échec,
/// rien n'est installé. `app.restart()` ne retourne jamais (relance le process).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

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

    tracing::info!("Slate update installed — restarting");
    app.restart();
}
