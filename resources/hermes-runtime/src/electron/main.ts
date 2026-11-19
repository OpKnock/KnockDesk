/**
 * KnockDesk Electron main process.
 *
 * The main window loads the source-owned desktop renderer. Hermes and AgentTown
 * are local sidecars embedded by the renderer; the UI never blocks on a backend
 * startup timeout.
 */
import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'node:path';

import {
  registerDomainHandlers,
  setMainWindow,
  setHermesManager,
  setKnockDeskBridge,
  setAgentTownManager,
} from './main/ipc/index.js';
import { ensureKnockDeskDirectories } from './main/bootstrap/knockdesk-bootstrap.js';
import { KnockDeskBridge } from './services/knockdesk-bridge.js';
import {
  ensureKnockDeskPlugin,
  ensureKnockDeskComputerPlugin,
  ensureKnockDeskMemoryPlugin,
} from './services/knockdesk-plugin.js';
import { HermesManager } from './services/hermes-manager.js';
import { AgentTownManager } from './services/agenttown-manager.js';
import { registerDesktopHandlers } from './services/desktop-manager.js';

let mainWindow: BrowserWindow | null = null;
let hermesManager: InstanceType<typeof HermesManager> | null = null;
let agentTownManager: InstanceType<typeof AgentTownManager> | null = null;
let knockDeskBridge: InstanceType<typeof KnockDeskBridge> | null = null;
let ipcHandlersRegistered = false;
let servicesPromise: Promise<void> | null = null;

app.disableHardwareAcceleration();
app.setAppUserModelId('com.knockdesk.app');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

async function createWindow(): Promise<BrowserWindow> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: '#090c12',
    title: 'KnockDesk',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0c10',
      symbolColor: '#66d9f4',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'desktop-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: true,
    },
    icon: path.join(__dirname, 'pwa', 'icon-512.png'),
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Register IPC exactly once. macOS can reopen windows without restarting
  // the process; ipcMain.handle rejects duplicate registrations.
  setMainWindow(mainWindow);
  if (!ipcHandlersRegistered) {
    registerDomainHandlers();
    ipcHandlersRegistered = true;
  }

  if (process.env.NODE_ENV === 'development') {
    const rendererUrl = process.env.KNOCKDESK_RENDERER_URL || 'http://127.0.0.1:5174/desktop.html';
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  // Show the interface first; do not leave a blank, hidden window while Hermes
  // takes time to boot. Sidecar initialization reports its own failures to UI.
  void initializeServices(mainWindow).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[KnockDesk] Service initialization failed:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('knockdesk-startup-error', message);
    }
  });

  return mainWindow;
}

async function initializeServices(window: BrowserWindow): Promise<void> {
  if (!servicesPromise) servicesPromise = initializeServicesOnce(window);
  await servicesPromise;

  // The window may have been closed and recreated while sidecars were starting.
  if (hermesManager) hermesManager.mainWindow = window;
  if (agentTownManager) agentTownManager.mainWindow = window;
}

async function initializeServicesOnce(window: BrowserWindow): Promise<void> {
  ensureKnockDeskDirectories(app);
  await ensureKnockDeskPlugin();
  await ensureKnockDeskComputerPlugin();
  await ensureKnockDeskMemoryPlugin();

  hermesManager = new HermesManager();
  hermesManager.mainWindow = window;
  setHermesManager(hermesManager);

  agentTownManager = new AgentTownManager();
  agentTownManager.mainWindow = window;
  setAgentTownManager(agentTownManager);

  registerDesktopHandlers();

  knockDeskBridge = new KnockDeskBridge({ userDataDir: app.getPath('userData') });
  setKnockDeskBridge(knockDeskBridge);
  await knockDeskBridge.start();

  // HermesManager.start() waits for the HTTP API to become ready (up to several
  // minutes on first boot), so intentionally do not await it in window startup.
  void hermesManager.start().catch((error: unknown) => {
    console.error('[KnockDesk] Hermes start failed:', error);
  });
}

app.whenReady().then(createWindow).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[KnockDesk] Window startup failed:', error);
  dialog.showErrorBox('KnockDesk could not start', message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(console.error);
});

app.on('before-quit', async () => {
  await knockDeskBridge?.stop?.();
  await hermesManager?.stop?.();
  await agentTownManager?.stop?.();
});

process.on('uncaughtException', (error) => {
  console.error('[KnockDesk] Uncaught exception:', error);
  dialog.showErrorBox('KnockDesk Error', `An unexpected error occurred:\n${error.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[KnockDesk] Unhandled rejection:', reason);
});

export { app, mainWindow, hermesManager, agentTownManager, knockDeskBridge };
