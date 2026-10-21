//! Enregistrement atomique : le contenu est écrit dans un fichier caché au nom
//! imprévisible, à côté de la cible, synchronisé sur le disque, puis renommé
//! par-dessus. Un plantage ou un disque plein en cours d'écriture laisse
//! l'original intact au lieu d'un fichier tronqué.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Noms de fichier temporaire essayés avant d'abandonner. Un nom aléatoire de
/// 64 bits n'est déjà pris que si quelqu'un l'a planté exprès.
const STAGING_ATTEMPTS: usize = 16;

/// Octets du nom de la cible gardés dans le nom temporaire, coupés entre deux
/// caractères : le nom complet reste sous la limite de 255 octets.
const STAGING_STEM_MAX: usize = 128;

pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    // Un lien symbolique est suivi : on remplace le fichier pointé, pas le lien.
    let target = match std::fs::canonicalize(target) {
        Ok(real) => real,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => target.to_path_buf(),
        Err(e) => return Err(e.to_string()),
    };
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = target
        .file_name()
        .ok_or_else(|| "invalid_save_path".to_string())?
        .to_string_lossy()
        .into_owned();
    // Le renommage passerait outre la lecture seule, qu'un `fs::write` respecte.
    if std::fs::metadata(&target).is_ok_and(|meta| meta.permissions().readonly()) {
        return Err("file_read_only".to_string());
    }

    let (staging, mut file) = create_staging(&dir, &name)?;
    let written = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        if let Ok(meta) = std::fs::metadata(&target) {
            file.set_permissions(meta.permissions())?;
            #[cfg(unix)]
            copy_extended_attributes(&target, &staging);
        }
        sync_staged(&file)?;
        drop(file);
        std::fs::rename(&staging, &target)?;
        sync_directory(&dir);
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&staging);
        return Err(e.to_string());
    }
    Ok(())
}

fn create_staging(dir: &Path, name: &str) -> Result<(PathBuf, std::fs::File), String> {
    use std::hash::BuildHasher;
    let mut stem = String::new();
    for c in name.chars() {
        if stem.len() + c.len_utf8() > STAGING_STEM_MAX {
            break;
        }
        stem.push(c);
    }
    let keys = std::hash::RandomState::new();
    for attempt in 0..STAGING_ATTEMPTS as u64 {
        let suffix = keys.hash_one(attempt);
        let path = dir.join(format!(".{stem}.slate-{suffix:016x}.tmp"));
        // `create_new` refuse tout ce qui existe déjà à ce nom (fichier, lien,
        // dossier) : un fichier planté ne peut ni recevoir ni détourner l'écriture.
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && path.symlink_metadata().is_ok() => {}
            Err(e) => return Err(format!("staging_file_unavailable: {e}")),
        }
    }
    Err("staging_file_unavailable: every temporary name is taken".to_string())
}

/// Recopie les attributs étendus (étiquettes et commentaires Finder, origine du
/// téléchargement…). Un attribut que le système refuse d'écrire est ignoré : il
/// ne doit pas faire échouer l'enregistrement du contenu.
#[cfg(unix)]
fn copy_extended_attributes(from: &Path, to: &Path) {
    let Ok(names) = xattr::list(from) else { return };
    for name in names {
        if let Ok(Some(value)) = xattr::get(from, &name) {
            let _ = xattr::set(to, &name, &value);
        }
    }
}

/// Sous macOS, `sync_all` demande un vidage complet (`F_FULLFSYNC`) que les
/// volumes SMB et FUSE (Cryptomator…) refusent : là, un `fsync` simple est le
/// plus fort qu'ils offrent. Toute autre erreur fait toujours échouer l'écriture.
fn sync_staged(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        match file.sync_all() {
            Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTSUP | libc::ENOTTY)) => {
                if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            }
            other => other,
        }
    }
    #[cfg(not(target_os = "macos"))]
    file.sync_all()
}

/// Rend le renommage durable. Sans effet (et sans erreur) là où un dossier ne
/// s'ouvre pas en fichier, comme sous Windows.
fn sync_directory(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slate-atomic-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_content_and_leaves_no_staging_file() {
        let dir = test_dir("replace");
        let target = dir.join("doc.pdf");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new content").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_a_missing_file() {
        let dir = test_dir("create");
        let target = dir.join("nouveau.pdf");
        write_atomic(&target, b"%PDF").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_read_only_file() {
        let dir = test_dir("readonly");
        let target = dir.join("locked.pdf");
        std::fs::write(&target, b"old").unwrap();
        let mut perms = std::fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&target, perms.clone()).unwrap();
        assert_eq!(write_atomic(&target, b"new").unwrap_err(), "file_read_only");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(&target, perms);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_and_follows_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = test_dir("perms");
        let real = dir.join("real.pdf");
        std::fs::write(&real, b"old").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("link.pdf");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&real).unwrap(), b"new");
        assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o640);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
