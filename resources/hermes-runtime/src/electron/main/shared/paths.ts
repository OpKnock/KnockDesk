/**
 * KnockDesk Path Utilities
 * 
 * Centralized path management for all data files.
 */

import { app } from 'electron';
import * as path from 'path';

export interface Paths {
  getMemoryPath: () => string;
  getUserProfilePath: () => string;
  getDashboardSettingsPath: () => string;
  getFolderConfigPath: () => string;
  getVaultPath: () => string;
  getHistoryPath: () => string;
  getHistorySettingsPath: () => string;
  getContactsPath: () => string;
  getNotesPath: () => string;
  getTasksPath: () => string;
  getSecretKeyPath: () => string;
  getGroqKeyPath: () => string;
  getOpenAIKeyPath: () => string;
  getOpenRouterKeyPath: () => string;
  getKimiKeyPath: () => string;
  getGeminiPreferencePath: () => string;
  getVoiceAssistantModePath: () => string;
  getVoiceProviderPath: () => string;
  getChatsPath: () => string;
  getCustomModelsPath: () => string;
  getWhatsAppSettingsPath: () => string;
  getGoogleAuthPath: () => string;
}

/**
 * Creates path getters for all KnockDesk data files.
 * Uses app.getPath() for platform-appropriate user data directories.
 */
export function createPaths(): Paths {
  const userData = app.getPath('userData');
  const documents = app.getPath('documents');

  return {
    getMemoryPath: () => path.join(userData, 'memories.json'),
    getUserProfilePath: () => path.join(userData, 'user_profile.json'),
    getDashboardSettingsPath: () => path.join(userData, 'dashboard_settings.json'),
    getFolderConfigPath: () => path.join(userData, 'imported_folders.json'),
    getVaultPath: () => path.join(documents, 'KnockDesk_Vault'),
    getHistoryPath: () => path.join(userData, 'history.json'),
    getHistorySettingsPath: () => path.join(userData, 'history_settings.json'),
    getContactsPath: () => path.join(userData, 'contacts.json'),
    getNotesPath: () => path.join(userData, 'notes.json'),
    getTasksPath: () => path.join(userData, 'tasks.json'),
    getSecretKeyPath: () => path.join(userData, 'secret_key.json'),
    getGroqKeyPath: () => path.join(userData, 'groq_key.json'),
    getOpenAIKeyPath: () => path.join(userData, 'openai_key.json'),
    getOpenRouterKeyPath: () => path.join(userData, 'openrouter_key.json'),
    getKimiKeyPath: () => path.join(userData, 'kimi_key.json'),
    getGeminiPreferencePath: () => path.join(userData, 'gemini_preference.json'),
    getVoiceAssistantModePath: () => path.join(userData, 'voice_assistant_mode.json'),
    getVoiceProviderPath: () => path.join(userData, 'voice_provider_preference.json'),
    getChatsPath: () => path.join(userData, 'chats.json'),
    getCustomModelsPath: () => path.join(userData, 'custom_models.json'),
    getWhatsAppSettingsPath: () => path.join(userData, 'whatsapp_settings.json'),
    getGoogleAuthPath: () => path.join(userData, 'google_oauth.json'),
  };
}

/**
 * Preload script path for Electron BrowserWindow.
 * Used in main.ts for webPreferences.preload.
 */
export const preloadPath: string = path.resolve(__dirname, '../../preload.js');