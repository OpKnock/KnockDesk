export {};

type KnockDeskRuntimeState = {
  state: "idle" | "starting" | "ready" | "error" | "stopped" | string;
  error?: string | null;
  url?: string | null;
  port?: number;
  status?: Record<string, unknown> | null;
  external?: boolean;
  knockdeskReady?: boolean;
  knockdeskPending?: boolean;
  knockdeskError?: string | null;
};

type KnockDeskAgentTownState = {
  state: string;
  error?: string | null;
  url?: string | null;
  port?: number;
  external?: boolean;
  bundled?: boolean;
};

type KnockDeskDesktopAPI = {
  getRuntimeState(): Promise<KnockDeskRuntimeState>;
  startRuntime(): Promise<KnockDeskRuntimeState>;
  getHermesPreloadPath(): Promise<string | null>;
  getAgentTownState(): Promise<KnockDeskAgentTownState>;
  startAgentTown(): Promise<KnockDeskAgentTownState>;
  getAgentTownPreloadPath(): Promise<string | null>;
  readMemory(): Promise<{ available?: boolean; memory?: string; user?: string }>;
  requestMemory(instruction: string): Promise<{ ok?: boolean; error?: string }>;
  getSystemInfo(): Promise<Record<string, unknown> | unknown>;
  openExternal(target: string): Promise<unknown>;
  onRuntimeState(callback: (state: KnockDeskRuntimeState) => void): () => void;
  onAgentTownState(callback: (state: KnockDeskAgentTownState) => void): () => void;
  onStartupError(callback: (message: string) => void): () => void;
};

declare global {
  interface Window {
    knockdeskAPI?: KnockDeskDesktopAPI;
  }
}

export type { KnockDeskRuntimeState, KnockDeskAgentTownState, KnockDeskDesktopAPI };
