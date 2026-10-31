/**
 * KnockDesk IPC Handlers - Main Entry Point
 * 
 * Registers all IPC handlers for the main process.
 * Uses getter pattern for cross-module access to avoid circular dependencies.
 */

import { registerSkillsHandlers } from './skills-handlers.js';
import { registerSystemHandlers } from './system-handlers.js';
import { registerWhatsAppHandlers } from './whatsapp-handlers.js';
import { registerHermesHandlers } from './hermes-handlers.js';
import { registerAgentTownHandlers } from './agenttown-handlers.js';
import { registerKnockDeskRemoteHandlers } from './knockdesk-remote-handlers.js';
import { registerComputerHandlers } from './computer-handlers.js';
import { registerAwarenessHandlers } from './awareness-handlers.js';
import { registerMemoryHandlers } from './memory-handlers.js';
import { registerFaceLockHandlers } from './facelock-handlers.js';
import { registerOnboardingHandlers } from './onboarding-handlers.js';

// Shared state for cross-module access (set by main.ts after window creation)
let _mainWindow: Electron.BrowserWindow | null = null;
let _hermesManager: any = null;
let _agentTownManager: any = null;
let _knockdeskBridge: any = null;
let _computerManager: any = null;
let _awarenessManager: any = null;
let _memoryService: any = null;
let _faceLockManager: any = null;

export function registerDomainHandlers(): void {
  registerSystemHandlers();
  // Skills needs Hermes so an on/off toggle reaches the agents too — both
  // sides read the same folder now. Passed as a getter: the manager is
  // assigned by main.ts after this runs.
  registerSkillsHandlers({
    getHermesManager: () => _hermesManager,
  });
  registerWhatsAppHandlers();
  registerHermesHandlers({
    getHermesManager: () => _hermesManager,
  });
  registerAgentTownHandlers({
    getAgentTownManager: () => _agentTownManager,
  });
  // Mobile Remote. Getters are used because these handlers register
  // before the bridge/manager exists. The getters allow lazy access.
  registerKnockDeskRemoteHandlers({
    getBridge: () => _knockdeskBridge,
    getHermesManager: () => _hermesManager,
  });
  // Computer use (Agent S3 sidecar). Getter, same reason as above.
  registerComputerHandlers({
    getComputerManager: () => _computerManager,
  });
  // Awareness (Proactive Presence). Getter, same reason as above.
  registerAwarenessHandlers({
    getAwarenessManager: () => _awarenessManager,
  });
  // Memory Core. Getter, same reason as above.
  registerMemoryHandlers({
    getMemoryService: () => _memoryService,
    getHermesManager: () => _hermesManager,
  });
  // Face Lock (Settings → Profile). Getter, same reason as above.
  registerFaceLockHandlers({
    getFaceLockManager: () => _faceLockManager,
  });
  // Onboarding system scan.
  registerOnboardingHandlers();
}

export function setMainWindow(win: Electron.BrowserWindow): void {
  _mainWindow = win;
}

export function getMainWindow(): Electron.BrowserWindow | null {
  return _mainWindow;
}

export function getHermesManager(): any {
  return _hermesManager;
}

export function setHermesManager(mgr: any): void {
  _hermesManager = mgr;
}

export function getAgentTownManager(): any {
  return _agentTownManager;
}

export function setAgentTownManager(mgr: any): void {
  _agentTownManager = mgr;
}

export function getKnockDeskBridge(): any {
  return _knockdeskBridge;
}

export function setKnockDeskBridge(bridge: any): void {
  _knockdeskBridge = bridge;
}

export function getComputerManager(): any {
  return _computerManager;
}

export function setComputerManager(mgr: any): void {
  _computerManager = mgr;
}

export function getAwarenessManager(): any {
  return _awarenessManager;
}

export function setAwarenessManager(mgr: any): void {
  _awarenessManager = mgr;
}

export function getMemoryService(): any {
  return _memoryService;
}

export function setMemoryService(svc: any): void {
  _memoryService = svc;
}

export function getFaceLockManager(): any {
  return _faceLockManager;
}

export function setFaceLockManager(mgr: any): void {
  _faceLockManager = mgr;
}

// Compat: pre-rebrand main.jsc destructures the Stonic bridge accessors.
export const getStonicBridge = getKnockDeskBridge;
export const setStonicBridge = setKnockDeskBridge;