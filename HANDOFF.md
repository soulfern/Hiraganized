# Handoff — Hiraganized (soulfern/Hiraganized)

Paste this into a fresh Claude Code session (or read `HANDOFF.md`) to pick up where the last session left off.

---

## Project

**Hiraganized** — an Electron app for Windows: "Instant kanji context." Global hotkey → drag-select any on-screen Japanese text → OCR (manga-ocr) → popup with readings/meanings for each kanji and real compounds. Lives in the system tray.

- Repo: `https://github.com/soulfern/Hiraganized` (public, owned by **soulfern**)
- Working dir: `C:\Projects\Hiraganized`
- Stack: Electron 37, plain JS (CommonJS), `node --test`, electron-builder (portable target)
- Two packages: the **app** (`package.json`) and a **standalone installer app** (`installer/package.json`) that packages the app into `installer/dist/Hiraganized-Setup-<ver>.exe`.

## Current state (IMPORTANT)

- **Version: 1.0.1** everywhere (both package.json files; installer registry `DisplayVersion` is hardcoded `'1.0.1'` in `installer/src/main/main.js`).
- **Fresh installer built and verified:** `installer/dist/Hiraganized-Setup-1.0.1.exe` (132 MB, signed, built 2026-07-31 22:12). It contains ALL work below (11-point verification passed).
- **Nothing is committed.** The git history stops at `61b12eb "Add MIT license"`. Everything since then is uncommitted (12 modified files + 5 untracked). The standing instruction from the user is **"Do not commit yet"** — do not commit/push without explicit approval.
- GitHub release `v1.0.0` exists and still carries the OLD installer (from before all this work). A `v1.0.1` release has NOT been created. The user has not approved pushing/creating it.

## What has been done this session

### 1. Compound kanji display fix
- `src/main/dictionary-service.js`: `lookupCompound()` no longer merges per-char lookups into a confusing single entry — it returns `null` when Jisho has no real match. Added `segmentSequence()` which greedily splits a kanji run into genuine compounds (e.g. `毎日日本語` → `毎日` + `日本語`); leftover chars fall through to the per-character loop.
- `src/main/main.js`: the capture pipeline now segments runs before compounding.
- Reproduced live: `時間` → real compound; `毎日日本語` → two real compounds; isolated chars → individual entries.

### 2. Windows uninstaller (shows in "Installed apps")
- `installer/src/main/main.js`: added `registerUninstall()` — writes `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Hiraganized` with `UninstallString = "<installDir>\Hiraganized.exe" --uninstall` (requires the installer's admin elevation). So the app now appears in Windows Settings → Apps.
- App gained an uninstall mode: `src/main/uninstaller.js` + `src/main/uninstall-preload.js` + `src/renderer/uninstall.html` + `src/renderer/uninstall.js`. `src/main/main.js` branches to it when launched with `--uninstall` (before the single-instance lock).
- The uninstall UI lets the user choose what to remove: (locked) app files + shortcuts + registry entry, plus optional **settings/logs** and optional **OCR engine** (Python 3.12 dir + HF model cache). Cleanup runs via an elevated, detached PowerShell script that waits for the app to exit, force-kills stragglers, removes targets, and self-deletes.
- **Known gap:** the OCR-removal option only deletes `%LOCALAPPDATA%\Programs\Python\Python312` and `~\.cache\huggingface\hub\models--kha-white--manga-ocr-base`. If the installer reused a pre-existing Python the user installed themselves, that Python is not touched (and removing `Python312` dir is a no-op). Fine for the common case; be aware.

### 3. Dictionary caching (re-introduced, per explicit request)
- `src/main/dictionary-service.js`: every successful kanji (`kanjiapi.dev`) and compound (`jisho.org`) lookup is now cached in memory AND persisted (debounced 2 s) to `userData/dictionary-cache.json`. Subsequent lookups (same or future sessions) resolve instantly/offline. Compound cache keys are `#`-prefixed. "Not a word" negatives are cached in-memory only (never persisted). Transient failures are never cached.
- `src/main/main.js`: constructs `new DictionaryService(cachePath).load()` and calls `dictionary.flush()` on quit.
- Note: this reverses an earlier in-session decision to be "online only, no storage" — the user changed their mind and wants local caching for speed.

### 4. New settings (defaults + UI)
- `src/main/defaults.js`: `general.launchOnStartup` (false), `general.startMinimized` (false), `general.showCompoundCharacters` (true).
- `src/main/main.js`: `applyLoginItemSettings()` syncs Windows startup (HKCU Run key) with `--hidden` arg when enabled; `startedFromStartup()` checks `--hidden`. `createMainWindow` respects `startMinimized` only when launched via startup. `showKanjiPopup` skips expanding compound children when `showCompoundCharacters` is false.
- `src/renderer/index.html` + `app.js` + `styles.css`: toggle switches; **Start minimized is disabled (and forced off) unless Launch on startup is on.**

### 5. UI color palette (per explicit request)
- `src/renderer/styles.css`: `--bg-deep: #1e1e1e`, window edge `--window-edge: #545454`, `--text-primary: #d9d9d9`. Applied to main window, popup, overlay info pill, and the uninstall window (`uninstall.html`); installer window `backgroundColor` also `#1e1e1e`.
- Fixed a pre-existing CSS bug: `.brand-name` rule contained literal `\n` characters (broken rule) — rewrote it properly.

### 6. Installer UI redesign
- `installer/src/renderer/index.html`: fully rewritten — modern, clean, palette-matched (Inter → now the app's own look), keeps every ID/class hook `renderer.js` uses. Timeline, progress cards with indeterminate shimmer, done page.
- Per later tweaks: title bar now shows **"Hiraganized Installer"**; the Welcome hero (name + tagline) and the three feature bullets were removed; Done description is exactly **"Hiraganized has been successfully installed."**
- `installer/src/main/main.js`: window `backgroundColor: #1e1e1e`.

### 7. Main UI sizing / spacing
- `src/main/main.js`: default window 480×400; `minWidth: 440, minHeight: 380` so settings can't be cut off; `restoreWindowState` clamps the restored size.
- Removed the settings description/hint rows; tightened row/divider spacing; `.settings-view` scrolls if ever constrained.

### 8. Lexend font (bundled locally)
- User asked for Lexend (Regular 400). Downloaded the real Latin subset static weights to `assets/fonts/Lexend-{300,400,500,600}.woff2` (each verified distinct — earlier a batch fetch returned one identical file for all weights, so it was re-fetched per-weight).
- `@font-face` rules at the top of `styles.css`; `--font-family: 'Lexend', ...`. Bundled locally (no CDN, no CSP change; `font-src` defaults to `'self'`).

### 9. Hotkey recorder fixes
- `src/renderer/app.js`: fixed the **"Shift+Shift"** preview bug (modifiers were appended as a key); rewrote recording to track held modifiers (`modsFromEvent`, `MODIFIER_KEYS`, `normalizeKey`).
- Recording now **commits when all keys are released**, so modifier-only hotkeys (e.g. just `Shift`) can be selected without pressing an extra key; a non-modifier key still commits immediately.
- Caveat: a modifier-only accelerator like `Shift` may not be registerable by Electron's `globalShortcut` on Windows; registration failure only logs a warning (existing behavior).

## Tests & verification
- `npm test` → **10/10 passing** (`tests/dictionary.test.js` now covers caching: cache-hit no re-fetch, disk persistence/reload, failed lookups not cached; `tests/config-store.test.js` covers settings merge/clamp).
- Every changed JS file passes `node --check`.
- Both the app and the installer launch cleanly (no console errors) via `node_modules/electron/dist/electron.exe .`.

## Build / release commands
- Rebuild (inner app + installer, cleans `dist/` + `installer/dist/`, ~10 min): `npm run rebuild` (runs `build/rebuild.js`).
- Output: `installer/dist/Hiraganized-Setup-1.0.1.exe`.
- Tests: `npm test`. Dev run: `npm start` (or the local electron binary directly).

## Known caveats / watch-outs
1. **Nothing committed** — 12 modified + 5 untracked files; `v1.0.0` GitHub release still ships the old build; no `v1.0.1` release created. Get user approval before committing, pushing, or creating a release.
2. **Uninstaller OCR scope** (see #2) — pre-existing user Python is not removed.
3. `installer/src/main/main.js` `registerUninstall` hardcodes `DisplayVersion: '1.0.1'` and `Publisher: 'soulfern'` — update if the version bumps.
4. Compound negatives are memory-only by design (avoids stale forever-cache if Jisho later adds a word).
5. The `.gitignore` ignores `dist/`, `installer/dist/`, `node_modules/`, `.icon-backup/`; `assets/fonts/` is untracked and SHOULD be committed with everything else when approved.
6. The app icon is the new `HiraganizedTransparent.png`-derived `assets/icon.png`/`icon.ico`; original backups sit in `.icon-backup/` (gitignored).

## Likely next steps (ask the user)
- Commit all pending changes and push to `soulfern/Hiraganized`.
- Create the `v1.0.1` GitHub release and upload the new installer.
- Optionally bump version to `1.0.2` (and registry `DisplayVersion`) if more work lands.
