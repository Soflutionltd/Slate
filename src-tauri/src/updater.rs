use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Background-checks GitHub Releases for a new signed Alto build and applies it.
///
/// Strategy:
///   1. Spawn a non-blocking task at startup so the UI isn't held back.
///   2. If a newer signed update is available, download + install it silently.
///   3. Restart the app so the user opens the new version on next launch.
///
/// Errors are logged via `tracing` and never propagated to the user — a failed
/// update should never block the app from running.
pub fn spawn_update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = check_and_install(&app).await {
            tracing::warn!("Alto auto-update failed: {err}");
        }
    });
}

async fn check_and_install(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        tracing::debug!("Alto is up to date");
        return Ok(());
    };

    tracing::info!(
        "Alto update available: {} -> {}",
        update.current_version,
        update.version
    );

    update
        .download_and_install(|_chunk_len, _content_len| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    tracing::info!("Alto update installed, restarting…");
    app.restart();
}
