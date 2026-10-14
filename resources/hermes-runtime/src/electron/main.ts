/**
 * KnockDesk Electron Main Process
 * 
 * Entry point for the Electron main process. This file is compiled with bytenode
 * to produce main.jsc for production distribution.
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Import IPC handlers
import { registerDomainHandlers, setMainWindow, getMainWindow } from './main/ipc/index.js';

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
    icon: path.join(__dirname, '../pwa/icon-512.png'),
  });

  // Load the dashboard
  const dashboardUrl = process.env.NODE_ENV === 'development'
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '../dist/index.html')}`;

  await mainWindow.loadURL(dashboardUrl);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Register IPC handlers with the main window
  setMainWindow(mainWindow);
  registerDomainHandlers();

  // Initialize services
  initializeServices(mainWindow);

  return mainWindow;
}

function initializeServices(window: BrowserWindow): void {
  // Initialize Hermes Manager
  hermesManager = new HermesManager();
  hermesManager.mainWindow = window;
  hermesManager.start();

  // Register Desktop handlers
  registerDesktopHandlers();

  // Initialize KnockDesk Bridge
  knockDeskBridge = new KnockDeskBridge({ userDataDir: app.getPath('userData') });
  knockDeskBridge.start();
}

// App event handlers
app.whenReady().then(createWindow).catch(console.error);

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