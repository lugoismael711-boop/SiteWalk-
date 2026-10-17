/* ============================================================
   SiteWalk desktop (Electron) — thin native wrapper
   ------------------------------------------------------------
   Loads the hosted SiteWalk PWA in a native window so it can be
   installed as .exe/.dmg. The web app is a service-worker PWA,
   so after the first online launch it also works offline, and
   (once Firebase sync is configured) it shares one login with
   the phone. External links open in the system browser.
   ============================================================ */

const { app, BrowserWindow, shell, Menu } = require('electron');

const APP_URL = process.env.SITEWALK_URL || 'https://sitewalk-462ee.web.app/';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    title: 'SiteWalk',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(APP_URL);

  // Open target=_blank / external links in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep navigation inside the app's own origin; send anything else outward.
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const here = new URL(APP_URL).origin;
      if (new URL(url).origin !== here) { e.preventDefault(); shell.openExternal(url); }
    } catch (_) { /* ignore */ }
  });
}

// A minimal menu (keeps standard shortcuts: copy/paste, reload, devtools, quit).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
