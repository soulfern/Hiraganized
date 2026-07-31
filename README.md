# Hiraganized

Instant kanji context for Windows. Select any Japanese text on screen and get readings and meanings in a lightweight popup.

## How it works

1. Press the global capture hotkey (default `Ctrl+Shift+K`).
2. Drag to select a region of the screen containing Japanese text.
3. The selected region is OCR'd and each kanji (and common compounds) is looked up, then shown in a compact popup.

Hiraganized lives in the system tray and stays out of the way until you need it.

## Features

- **Screen-region OCR** powered by [manga-ocr](https://github.com/kha-white/manga-ocr), tuned for Japanese text.
- **Online kanji lookups** via [kanjiapi.dev](https://kanjiapi.dev) for single characters and [Jisho](https://jisho.org) for compounds — always up to date, nothing bundled.
- **Per-kanji breakdown** with on'yomi / kun'yomi readings, meanings, and JLPT level.
- **Tray-based, always-ready** with a configurable capture hotkey.
- **Frameless, themed UI** that stays visually consistent from setup through results.

## First launch

On first run, Hiraganized sets up its OCR engine automatically:

- If a compatible Python 3.12 isn't found, it is downloaded and installed silently.
- `manga-ocr` and its dependencies are installed via pip.
- The OCR model (~450 MB) is downloaded on first use.

This is a one-time setup; subsequent launches start immediately. Progress is shown in-app and can be cancelled.

## Requirements

- Windows 10/11 (x64)
- Internet connection (for kanji lookups and first-time OCR setup)

## Development

```bash
npm install        # install dependencies
npm start          # run the app in development
npm test           # run the test suite (node --test)
npm run rebuild    # build the inner app + installer into installer/dist
```

### Project layout

```
src/main/        Electron main process (windows, tray, capture pipeline, OCR, lookups)
src/renderer/    UI surfaces: main window, selection overlay, result popup
build/           Build/clean scripts
installer/       Standalone Electron installer app
tests/           Unit tests
assets/          Application icons
```

## Building

`npm run rebuild` produces a portable installer at `installer/dist/Hiraganized-Setup-1.0.0.exe`. It:

1. Cleans previous build output.
2. Packages the inner app with `electron-builder --dir`.
3. Bundles it inside the standalone installer.

## License

MIT
