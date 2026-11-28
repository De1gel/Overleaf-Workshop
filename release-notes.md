## Fixes

- Reuse the Overleaf connection during ordinary document refreshes to prevent duplicate online sessions.
- Wait for pending editor writes before reconnecting to recover a changed project tree.
- Fix path handling when nested files are renamed and folders are moved or removed.
- Handle optional CSpell settings during startup.

## Install

Download `overleaf-workshop-0.15.13.vsix` and run **Extensions: Install from VSIX…** in desktop VS Code. Choose the downloaded file and reload the window if prompted.

The same VSIX was tested in clean VS Code profiles on Windows, Linux, and macOS. Use `SHA256SUMS.txt` to verify the download.
