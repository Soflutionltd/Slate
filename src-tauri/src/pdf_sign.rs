//! Signature électronique PAdES (PDF Advanced Electronic Signatures) via la
//! crate `underskrift`. On signe à partir d'un certificat PKCS#12 (.p12/.pfx)
//! fourni par l'utilisateur, en signature invisible (conforme PAdES B-B).
//!
//! La signature est ajoutée par mise à jour incrémentale : le contenu d'origine
//! n'est jamais réécrit, seul un nouveau revision bloc est ajouté en fin de
//! fichier — c'est ce qui rend la signature cryptographiquement vérifiable.

use underskrift::{PdfSigner, SigningOptions, SoftwareSigner, SubFilter};

/// Signe un PDF avec un certificat PKCS#12 et renvoie le PDF signé.
pub async fn sign_pdf_pades(
    pdf_bytes: &[u8],
    p12_path: &str,
    password: &str,
    reason: Option<String>,
    location: Option<String>,
    contact: Option<String>,
) -> Result<Vec<u8>, String> {
    if !pdf_bytes.starts_with(b"%PDF-") {
        return Err("The selected file is not a valid PDF document.".to_string());
    }

    let signer = SoftwareSigner::from_pkcs12_file(p12_path, password)
        .map_err(|e| format!("Unable to read the certificate (.p12): {e}"))?;

    let options = SigningOptions {
        sub_filter: SubFilter::Pades,
        field_name: "Signature1".to_string(),
        reason,
        location,
        contact_info: contact,
        ..Default::default()
    };

    PdfSigner::new()
        .options(options)
        .sign(pdf_bytes, &signer)
        .await
        .map_err(|e| format!("Signing failed: {e}"))
}
