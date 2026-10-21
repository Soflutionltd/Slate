//! Octets volumineux entre la WebView et Rust, sans tableau JSON.
//!
//! Un PDF passé en `number[]` coûte un nombre JSON par octet : 157 Mo deviennent
//! 157 millions d'éléments, plusieurs Go dans la WebView, qui finit tuée. Ici le
//! frontend dépose d'abord les octets en corps binaire (`stage_bytes`) et ne passe
//! qu'un jeton `staged:<n>` dans les arguments JSON de la commande. Dans l'autre
//! sens, un `DocBytes` sérialisé dépose ses octets et n'écrit que le jeton, que le
//! frontend échange contre une réponse binaire (`take_staged_bytes`).
//!
//! `DocBytes` accepte encore un tableau d'octets : un appel resté en `number[]`
//! fonctionne (lentement) au lieu d'échouer.

use std::collections::HashMap;
use std::fmt;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

const TOKEN_PREFIX: &str = "staged:";
/// Un jeton jamais consommé (commande abandonnée côté frontend) est purgé après ce délai.
const STAGED_TTL: Duration = Duration::from_secs(120);

static STAGED: LazyLock<Mutex<HashMap<u64, (Instant, Vec<u8>)>>> = LazyLock::new(Default::default);
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

fn stage(bytes: Vec<u8>) -> String {
    let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    let now = Instant::now();
    let mut staged = STAGED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    staged.retain(|_, (at, _)| now.duration_since(*at) < STAGED_TTL);
    staged.insert(token, (now, bytes));
    format!("{TOKEN_PREFIX}{token}")
}

fn take(token: &str) -> Option<Vec<u8>> {
    let id: u64 = token.strip_prefix(TOKEN_PREFIX)?.parse().ok()?;
    STAGED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&id)
        .map(|(_, bytes)| bytes)
}

#[derive(Clone, Default)]
pub struct DocBytes(pub Vec<u8>);

impl fmt::Debug for DocBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DocBytes({} bytes)", self.0.len())
    }
}

impl Deref for DocBytes {
    type Target = Vec<u8>;
    fn deref(&self) -> &Vec<u8> {
        &self.0
    }
}

impl DerefMut for DocBytes {
    fn deref_mut(&mut self) -> &mut Vec<u8> {
        &mut self.0
    }
}

impl AsRef<[u8]> for DocBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for DocBytes {
    fn from(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

impl From<DocBytes> for Vec<u8> {
    fn from(bytes: DocBytes) -> Self {
        bytes.0
    }
}

impl Serialize for DocBytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&stage(self.0.clone()))
    }
}

struct DocBytesVisitor;

impl<'de> Visitor<'de> for DocBytesVisitor {
    type Value = DocBytes;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a staged bytes token or an array of bytes")
    }

    fn visit_str<E: de::Error>(self, token: &str) -> Result<DocBytes, E> {
        take(token)
            .map(DocBytes)
            .ok_or_else(|| E::custom(format!("staged_bytes_missing: {token}")))
    }

    fn visit_bytes<E: de::Error>(self, bytes: &[u8]) -> Result<DocBytes, E> {
        Ok(DocBytes(bytes.to_vec()))
    }

    fn visit_byte_buf<E: de::Error>(self, bytes: Vec<u8>) -> Result<DocBytes, E> {
        Ok(DocBytes(bytes))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<DocBytes, A::Error> {
        let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(byte) = seq.next_element::<u8>()? {
            bytes.push(byte);
        }
        Ok(DocBytes(bytes))
    }
}

impl<'de> Deserialize<'de> for DocBytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(DocBytesVisitor)
    }
}

/// Dépose des octets envoyés en corps binaire brut (`Uint8Array` côté JS) et
/// renvoie le jeton à passer à la commande suivante.
#[tauri::command]
pub async fn stage_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("raw_body_required".to_string());
    };
    Ok(stage(bytes.clone()))
}

/// Échange un jeton (produit par un `DocBytes` sérialisé) contre ses octets, en
/// réponse binaire.
#[tauri::command]
pub async fn take_staged_bytes(token: String) -> Result<tauri::ipc::Response, String> {
    take(&token)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| format!("staged_bytes_missing: {token}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_round_trip_consumes_once() {
        let token = stage(vec![1, 2, 3]);
        let json = format!("\"{token}\"");
        let bytes: DocBytes = serde_json::from_str(&json).unwrap();
        assert_eq!(bytes.0, vec![1, 2, 3]);
        assert!(serde_json::from_str::<DocBytes>(&json).is_err());
    }

    #[test]
    fn legacy_array_still_accepted() {
        let bytes: DocBytes = serde_json::from_str("[37,80,68,70]").unwrap();
        assert_eq!(bytes.0, b"%PDF".to_vec());
    }

    #[test]
    fn serialize_stages_and_emits_token() {
        let json = serde_json::to_string(&DocBytes(vec![9, 8])).unwrap();
        let token: String = serde_json::from_str(&json).unwrap();
        assert_eq!(take(&token), Some(vec![9, 8]));
    }
}
