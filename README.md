# Alto Desktop

Native macOS / Windows / Linux shell for the Alto office suite.

The desktop app is a thin Tauri v2 wrapper that loads the production web app
(`https://alto-1vd.pages.dev`) inside a native webview, plus a few native
commands for file IO and an auto-updater pointed at GitHub Releases.

## Stack
- Tauri v2 (Rust + WebKit/WebView2/WebKitGTK)
- Plugins: `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-updater`
- Updater: minisign keypair stored at `~/.alto/alto.key{,.pub}` (passwordless)

## Native commands exposed to the webview
- `open_file()` → opens an OS file picker, returns `{ path, bytes[] }` for `.docx`
- `save_file(path, data)` → writes bytes to `path`
- `save_file_dialog(data)` → opens a save dialog, writes bytes, returns final path

## Local build (debug)
```bash
cd src-tauri
cargo tauri build --debug
# → target/debug/bundle/macos/Alto.app
# → target/debug/bundle/dmg/Alto_<version>_aarch64.dmg
```

To produce a signed updater payload locally:
```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.alto/alto.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
cargo tauri build --debug
```

## Release
```bash
./release.sh
```
This produces `Alto.app.tar.gz`, `Alto.app.tar.gz.sig`, the DMG and a
`latest.json` manifest. Upload these three files to a GitHub release tagged
`v<version>` on `Soflution1/sofdocs-desktop`. The auto-updater configured in
`tauri.conf.json` will pick it up automatically on next launch of any installed
Alto app.

## License
AGPL v3 — © 2026 Soflution LTD

Alto engine modules derived from ONLYOFFICE are AGPL v3 ports and retain
ONLYOFFICE / Ascensio source attribution. ONLYOFFICE trademarks and branded
assets are not part of Alto Desktop.
