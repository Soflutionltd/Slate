# slate-pdf-wasm

Bindings WASM pour le moteur PDF Slate (`alto-pdf-engine` + PDFium).

## Build (sur autorisation explicite)

```bash
cd crates/pdf-wasm
wasm-pack build --target web --out-dir pkg
```

Copier ensuite dans le dépôt SofDocs (application web, dossier séparé de ce dépôt) :

- `pkg/slate_pdf_wasm.js` + `pkg/slate_pdf_wasm_bg.wasm` → `SofDocs/apps/web/static/wasm/`
- PDFium WASM ([paulocoutinhox/pdfium-lib](https://github.com/paulocoutinhox/pdfium-lib/releases) tag `7902`, asset `wasm.tgz`) → `SofDocs/apps/web/static/wasm/pdfium/` (`pdfium.js` + `pdfium.wasm`)

Les assets WASM ne vont **pas** dans `frontend-dist` (évite +7 Mo dans le binaire desktop).

## Initialisation navigateur

`pdf-bridge.js` charge PDFium WASM, puis `slate_pdf_wasm`, appelle
`initialize_pdfium_render`, et expose la même API que les commandes Tauri.
