/**
 * KnockDesk Electron Main Process
 * 
 * Maintained Electron entrypoint. The shipped bytecode is not generated here.
 * This source opens the locally served Hermes dashboard so API calls and
 * session-token injection have the expected same-origin HTTP context.
 */

import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'path';

// Import IPC handlers
import { registerDomainHandlers, setMainWindow, setHermesManager, setKnockDeskBridge } from './main/ipc/index.js';

// Import services
import { ensureKnockDeskDirectories } from './main/bootstrap/knockdesk-bootstrap.js';
import { KnockDeskBridge } from './services/knockdesk-bridge.js';
import { ensureKnockDeskPlugin, ensureKnockDeskComputerPlugin, ensureKnockDeskMemoryPlugin } from './services/knockdesk-plugin.js';
import { HermesManager } from './services/hermes-manager.js';
import { registerDesktopHandlers } from './services/desktop-manager.js';

// Import preload scripts
import { preloadPath } from './main/shared/paths.js';

// Global references
let mainWindow: BrowserWindow | null = null;
let hermesManager: InstanceType<typeof HermesManager> | null = null;
let knockDeskBridge: InstanceType<typeof KnockDeskBridge> | null = null;

// Disable GPU acceleration for Windows 7 compatibility
app.disableHardwareAcceleration();

// Set app name for Windows taskbar
app.setAppUserModelId('com.knockdesk.app');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Create the main browser window
async function createWindow(): Promise<BrowserWindow> {
  // Ensure KnockDesk directories exist
  ensureKnockDeskDirectories(app);

  // Install Hermes plugins
  await ensureKnockDeskPlugin();
  await ensureKnockDeskComputerPlugin();
  await ensureKnockDeskMemoryPlugin();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0c10',
      symbolColor: '#4fc3f7',
      height: 36,
    },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    icon: path.join(__dirname, 'pwa/icon-512.png'),
  });

  // Install listeners before navigation to avoid missing ready-to-show.
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // IPC must exist before renderer preload code invokes the bridge.
  setMainWindow(mainWindow);
  registerDomainHandlers();

  // Hermes supplies the dashboard HTTP origin, API, and session bootstrap.
  // A file:// navigation cannot provide those services.
  const manager = await initializeServices(mainWindow);
  if (manager.state !== 'ready') {
    throw new Error('Hermes dashboard did not become ready: ' + (manager.error ?? manager.state));
  }
  const dashboardUrl = process.env.NODE_ENV === 'development'
    ? 'http://127.0.0.1:5173'
    : manager.baseUrl;
  await mainWindow.loadURL(dashboardUrl);
  return mainWindow;
}

async function initializeServices(window: BrowserWindow): Promise<InstanceType<typeof HermesManager>> {
  hermesManager = new HermesManager();
  hermesManager.mainWindow = window;
  setHermesManager(hermesManager);

  registerDesktopHandlers();

  knockDeskBridge = new KnockDeskBridge({ userDataDir: app.getPath('userData') });
  setKnockDeskBridge(knockDeskBridge);
  await knockDeskBridge.start();
  await hermesManager.start();
  return hermesManager;
}

// App event handlers
app.whenReady().then(createWindow).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[KnockDesk] Startup failed:', error);
  dialog.showErrorBox('KnockDesk could not start', message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  // Cleanup
  await knockDeskBridge?.stop?.();
  await hermesManager?.stop?.();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  dialog.showErrorBox('KnockDesk Error', `An unexpected error occurred:\n${error.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

export { app, mainWindow, hermesManager, knockDeskBridge };