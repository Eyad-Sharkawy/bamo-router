# Bamo Router

Desktop app for managing a Huawei home router from Windows. Built with **Angular** (UI) and **Electron** (desktop shell + router API).

## Features

- **Sign in** with your router admin username and password
- **Devices** — view connected clients, block or unblock internet per device
- **Wi‑Fi** — view and edit SSIDs, passwords, broadcast, and hidden-network settings
- **System** — reboot the router (with confirmation)

The app talks to the router over your local network (default gateway `https://192.168.100.1`).

## Requirements

- **Node.js** 20+ and npm
- **Windows** (installer build targets Windows x64)
- PC on the same network as the router
- Router admin credentials

## Quick start (development)

```bash
npm install
npm run dev
```

This starts the Angular dev server, compiles the Electron main process, and opens the desktop window. Sign in with your router credentials.

> Router features only work inside Electron (`npm run dev` or the packaged app), not in the browser alone.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev mode: Angular + Electron with hot reload |
| `npm run build:web` | Production Angular build → `dist/bamo-router/` |
| `npm run build:electron` | Compile Electron TypeScript → `dist-electron/` |
| `npm run build:app` | Build web + Electron (no installer) |
| `npm run dist:win` | Full Windows installer → `release/` |
| `npm test` | Unit tests (Vitest) |

## Build & ship (Windows)

1. Install dependencies:

   ```bash
   npm install
   ```

2. Ensure icons exist in `electron/assets/`:
   - `icon.png` — square, at least **256×256** (used in the UI and to generate `.ico`)
   - `icon.ico` — required for the `.exe` / installer (must include 256×256)

   Regenerate `.ico` from PNG:

   ```bash
   npm run build:icon
   ```

   Uses `icon-square.png` or `icon.png` via `scripts/generate-icon.mjs`.

3. Build the installer:

   ```bash
   npm run dist:win
   ```

4. Output:
   - **Installer:** `release/Bamo Router Setup 1.0.0.exe` — distribute this
   - **Portable:** `release/win-unpacked/` — run `Bamo Router.exe` without installing

Bump the version in `package.json` before each release; the installer name follows that version.

## App icon

| Location | Purpose |
|----------|---------|
| `electron/assets/icon.ico` | Windows app, taskbar, installer |
| `electron/assets/icon.png` | UI + fallback |
| `public/icon.png` | Login screen and header in the Angular UI |

After changing icons, run `npm run build:icon` (if needed), then `npm run dist:win` for a new installer.

## Project structure

```
bamo-router/
├── electron/           # Main process (router HTTP API, IPC)
│   ├── main.ts
│   ├── preload.ts
│   └── assets/         # App icons
├── src/app/            # Angular UI
├── public/             # Static assets (icon.png)
├── scripts/            # Icon generation helpers
├── dist-electron/      # Compiled Electron (generated)
├── dist/bamo-router/   # Compiled Angular (generated)
└── release/            # Packaged installers (generated)
```

## How it works

1. The **renderer** (Angular) calls `window.routerAPI` exposed by `electron/preload.ts`.
2. The **main process** (`electron/main.ts`) performs HTTPS requests to the router with cookie/session handling.
3. Login, devices, firewall rules, Wi‑Fi, and reboot map to the router’s web interface endpoints.

The default router URL is set in `electron/main.ts` (`https://192.168.100.1`). Change it there if your gateway uses a different address.

## Security notes

- Credentials are sent only to your local router; they are not stored in the app after sign-out (session cookies are cleared on logout).
- The main process disables TLS certificate verification for the router’s self-signed HTTPS certificate (`NODE_TLS_REJECT_UNAUTHORIZED`). This is required for many ISP routers but means you should only use the app on a trusted home network.

## Tech stack

- Angular 21
- Electron 42
- electron-builder (Windows NSIS installer)
- axios + tough-cookie (router session)

## License

Private — see repository owner for terms.
