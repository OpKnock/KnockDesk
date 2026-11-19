export {};

type KnockDeskRuntimeState = {
  state: "idle" | "starting" | "ready" | "error" | "stopped" | string;
  error?: string | null;
  url?: string | null;
  port?: number;
  status?: unknown;
  knockdeskReady?: boolean;
  knockdeskPending?: boolean;
  knockdeskError?: string | null;
};

type KnockDeskAgentTownState = {
  state: string;
  error?: string | null;
  url?: string | null;
  port?: number;
  bundled?: boolean;
};

type KnockDeskElectronAPI = {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, callback: (...args: any[]) => void): () => void;
  send(channel: string, ...args: unknown[]): void;
};

declare global {
  interface Window {
    electronAPI?: KnockDeskElectronAPI;
  }
}

export type { KnockDeskRuntimeState, KnockDeskAgentTownState };
