# Ternlux Releases

Distribution channel for the Ternlux desktop application.

Each GitHub Release in this repository contains the packaged installers and the
electron-updater manifests:

- **Windows** — NSIS installer (`.exe`) + `latest.yml`
- **Linux** — AppImage + `latest-linux.yml`
- **macOS** — DMG / ZIP + `latest-mac.yml`

The Ternlux app checks this repository via electron-updater to download and
apply updates. Builds are produced by the release workflow in the source
repository and published here automatically.
