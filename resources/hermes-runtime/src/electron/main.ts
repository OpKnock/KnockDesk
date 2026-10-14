/**
 * KnockDesk main process for the maintained, source-owned desktop UI.
 *
 * The renderer receives a narrow bridge. Legacy UI IPC is deliberately not
 * registered here; only the features shown in the maintained renderer are
 * exposed, and external command execution keeps Hermes' approval gate enabled.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const { ensureKnockDeskDirectories } = require('./main/bootstrap/knockdesk-bootstrap.js');
const {
  ensureKnockDeskPlugin,
  ensureKnockDeskMemoryPlugin,
} = require('./services/knockdesk-plugin.js');
const { DesktopHermesRuntime } = require('./services/desktop-hermes-runtime.js');
const { DesktopAgentTownRuntime } = require('./services/desktop-agenttown-runtime.js');

let mainWindow: BrowserWindow | null = null;
let hermesManager: any = null;
let agentTownManager: any = null;
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

function stateFallback(state = 'starting', error: string | null = null) {
  return { state, error, url: null, port: 0, external: false };
}

function registerDesktopIpc(): void {
  if (ipcHandlersRegistered) return;

  ipcMain.handle('knockdesk:open-external', async (_event, target: unknown) => {
    let parsed: URL;
    try {
      parsed = new URL(String(target));
    } catch {
      throw new Error('Invalid external URL');
    }
    if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
      throw new Error('Unsupported external URL protocol');
    }
    await shell.openExternal(parsed.toString());
    return true;
  });

  ipcMain.handle('knockdesk:runtime:get-state', () =>
    hermesManager ? hermesManager.getState() : stateFallback());

  ipcMain.handle('knockdesk:runtime:start', async () => {
    const initialized = await initializeServicesForIpc();
    if (!initialized || !hermesManager) {
      return stateFallback('error', 'The Hermes runtime could not be initialized.');
    }
    return hermesManager.start();
  });

  ipcMain.handle('knockdesk:runtime:preload', () => {
    const filename = path.join(__dirname, 'hermes-preload.js');
    return pathToFileURL(filename).toString();
  });

  ipcMain.handle('knockdesk:agenttown:get-state', () =>
    agentTownManager ? agentTownManager.getState() : stateFallback('idle'));

  ipcMain.handle('knockdesk:agenttown:start', async () => {
    const initialized = await initializeServicesForIpc();
    if (!initialized || !agentTownManager) {
      return stateFallback('error', 'AgentTown could not be initialized.');
    }
    return agentTownManager.start();
  });

  ipcMain.handle('knockdesk:agenttown:preload', () => {
    const filename = path.join(__dirname, 'agenttown-preload.js');
    return pathToFileURL(filename).toString();
  });

  ipcMain.handle('knockdesk:memory:read', async () => {
    const initialized = await initializeServicesForIpc();
    if (!initialized || !hermesManager) return { available: false, memory: '', user: '' };
    return hermesManager.readMemoryFiles();
  });

  ipcMain.handle('knockdesk:memory:update', async (_event, instruction: unknown) => {
    if (!hermesManager) return { ok: false, error: 'Hermes is not ready yet.' };
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return { ok: false, error: 'Enter a memory instruction first.' };
    }
    if (instruction.length > 4000) {
      return { ok: false, error: 'Memory instructions must be 4,000 characters or fewer.' };
    }
    return hermesManager.memoryRequest(instruction.trim());
  });

  ipcMain.handle('knockdesk:system:info', () => {
    const cpus = os.cpus();
    return {
      platform: process.platform,
      operatingSystem: os.type(),
      release: os.release(),
      architecture: os.arch(),
      cpuModel: cpus[0]?.model ?? 'Unknown',
      logicalProcessors: cpus.length,
      totalMemoryBytes: os.totalmem(),
      availableMemoryBytes: os.freemem(),
      systemUptimeSeconds: os.uptime(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
    };
  });

  ipcHandlersRegistered = true;
}

async function createWindow(): Promise<BrowserWindow> {
  registerDesktopIpc();

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

  if (process.env.NODE_ENV === 'development') {
    const rendererUrl = process.env.KNOCKDESK_RENDERER_URL || 'http://127.0.0.1:5174/desktop.html';
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, 'renderer', 'desktop.html'));
  }

  // CI smoke mode verifies Electron + the React renderer without installing or
  // launching the personal Hermes runtime. It is never enabled for normal runs.
  if (process.env.KNOCKDESK_SMOKE_MODE === '1') {
    console.log('[KnockDesk] Renderer smoke mode: sidecars intentionally disabled.');
  } else {
    // Do not hold the window hidden while the Python runtime warms up on first run.
    void initializeServices(mainWindow).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[KnockDesk] Service initialization failed:', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('knockdesk-startup-error', message);
      }
    });
  }

  return mainWindow;
}

async function initializeServices(window: BrowserWindow): Promise<void> {
  if (!servicesPromise) servicesPromise = initializeServicesOnce(window);
  await servicesPromise;
  if (hermesManager) hermesManager.mainWindow = window;
  if (agentTownManager) agentTownManager.mainWindow = window;
}

async function initializeServicesForIpc(): Promise<boolean> {
  const window = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows()[0] ?? null;
  if (!window) return false;
  await initializeServices(window);
  return true;
}

async function initializeServicesOnce(window: BrowserWindow): Promise<void> {
  ensureKnockDeskDirectories(app);
  await ensureKnockDeskPlugin();
  await ensureKnockDeskMemoryPlugin();

  hermesManager = new DesktopHermesRuntime();
  hermesManager.mainWindow = window;

  agentTownManager = new DesktopAgentTownRuntime();
  agentTownManager.mainWindow = window;

  // This manager performs bounded readiness polling and reports state events.
  void hermesManager.start().catch((error: unknown) => {
    console.error('[KnockDesk] Hermes start failed:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('knockdesk-startup-error',
        error instanceof Error ? error.message : String(error));
    }
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

let shutdownStarted = false;
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void Promise.allSettled([
    Promise.resolve().then(() => hermesManager?.stop?.()),
    Promise.resolve().then(() => agentTownManager?.stop?.()),
  ]).finally(() => app.quit());
});

process.on('uncaughtException', (error) => {
  console.error('[KnockDesk] Uncaught exception:', error);
  dialog.showErrorBox('KnockDesk Error', `An unexpected error occurred:\n${error.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[KnockDesk] Unhandled rejection:', reason);
});

export { app, mainWindow, hermesManager, agentTownManager };
