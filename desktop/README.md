# SiteWalk Desktop (Electron)

A thin native wrapper that opens the SiteWalk web app in its own window so it can
be installed as a **Windows `.exe`** or **macOS `.dmg`** (and a Linux AppImage).
It loads the hosted PWA, so it stays up to date automatically, works offline
after the first launch (service worker), and — once Firebase sync is configured —
shares one login with the phone.

## Download a prebuilt installer

Installers are built by GitHub Actions:

- **On demand:** GitHub → **Actions** → **Build desktop installers** → **Run
  workflow**. When it finishes, download the `sitewalk-win` / `sitewalk-mac`
  artifact (contains the `.exe` / `.dmg`).
- **As a Release:** push a tag like `v1.0.0` and the same workflow attaches the
  installers to a GitHub Release people can download directly.

> The builds are **unsigned** (no paid Apple/Windows code‑signing certificate),
> so the OS shows an "unidentified developer" warning the first time:
> - **Windows:** "More info" → "Run anyway".
> - **macOS:** right‑click the app → "Open" → "Open".
> Add signing certificates later to remove the warning.

## Build it yourself

Requires Node 18+ and the platform you're targeting (you can only build a `.dmg`
on macOS and an `.exe` on Windows):

```bash
cd desktop
npm install
npm start          # run the app in dev
npm run dist:win   # build the Windows installer   (on Windows)
npm run dist:mac   # build the macOS installer      (on macOS)
npm run dist:linux # build the Linux AppImage        (on Linux)
```

Output lands in `desktop/dist/`.

## Point it at a different URL

By default it opens the production site. To run it against a local/staging copy:

```bash
SITEWALK_URL="http://localhost:8000" npm start
```
