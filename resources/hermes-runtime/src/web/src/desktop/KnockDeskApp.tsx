import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUpRight, Bot, Brain, Check, ChevronRight, CircleAlert,
  Clock3, Command, Cpu, ExternalLink, FileText, Gauge, HardDrive,
  Home, Layers3, LoaderCircle, MessageSquare, Network, RefreshCw,
  Settings2, ShieldCheck, Sparkles, Terminal, Zap,
} from "lucide-react";
import type { KnockDeskAgentTownState, KnockDeskRuntimeState, KnockDeskDesktopAPI } from "./bridge";

type Page = "home" | "assistant" | "sessions" | "files" | "models" | "logs" | "cron" | "skills" | "plugins" | "mcp" | "pairing" | "channels" | "webhooks" | "docs" | "agenttown" | "memory" | "settings" | "system";
type ToastState = { type: "ok" | "error" | "info"; message: string } | null;
type MemoryState = { available?: boolean; memory?: string; user?: string };
type SystemInfo = Record<string, unknown>;

const nav: Array<{ id: Page; label: string; icon: typeof Home; group: string }> = [
  { id: "home", label: "Overview", icon: Home, group: "WORKSPACE" },
  { id: "assistant", label: "AI Assistant", icon: MessageSquare, group: "WORKSPACE" },
  { id: "sessions", label: "Sessions", icon: Layers3, group: "WORKSPACE" },
  { id: "files", label: "Files", icon: FileText, group: "WORKSPACE" },
  { id: "models", label: "Models", icon: Cpu, group: "WORKSPACE" },
  { id: "logs", label: "Logs", icon: Terminal, group: "WORKSPACE" },
  { id: "cron", label: "Scheduled jobs", icon: Clock3, group: "WORKSPACE" },
  { id: "agenttown", label: "AgentTown", icon: Network, group: "WORKSPACE" },
  { id: "skills", label: "Skills", icon: Sparkles, group: "MANAGE" },
  { id: "plugins", label: "Plugins", icon: Zap, group: "MANAGE" },
  { id: "mcp", label: "MCP tools", icon: Terminal, group: "MANAGE" },
  { id: "pairing", label: "Pairing", icon: ShieldCheck, group: "MANAGE" },
  { id: "channels", label: "Channels", icon: Network, group: "MANAGE" },
  { id: "webhooks", label: "Webhooks", icon: Activity, group: "MANAGE" },
  { id: "docs", label: "Documentation", icon: FileText, group: "MANAGE" },
  { id: "memory", label: "Memory", icon: Brain, group: "MANAGE" },
  { id: "system", label: "System health", icon: Activity, group: "MANAGE" },
  { id: "settings", label: "Settings & keys", icon: Settings2, group: "MANAGE" },
];

const pageTitles: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "Your command center", subtitle: "A clear view of your local AI workspace." },
  assistant: { title: "AI Assistant", subtitle: "Chat with your local Hermes agent runtime." },
  sessions: { title: "Sessions", subtitle: "Continue a conversation or review recent work." },
  files: { title: "Files", subtitle: "Browse files exposed by the Hermes dashboard." },
  models: { title: "Models", subtitle: "Review and select available AI models." },
  logs: { title: "Logs", subtitle: "Inspect runtime and agent activity." },
  cron: { title: "Scheduled jobs", subtitle: "Review scheduled automation." },
  skills: { title: "Skills", subtitle: "Manage skills available to the assistant." },
  plugins: { title: "Plugins", subtitle: "Review installed extensions." },
  mcp: { title: "MCP tools", subtitle: "Inspect Model Context Protocol integrations." },
  pairing: { title: "Pairing", subtitle: "Manage desktop pairing sessions." },
  channels: { title: "Channels", subtitle: "Configure messaging integrations." },
  webhooks: { title: "Webhooks", subtitle: "Review webhook integrations." },
  docs: { title: "Documentation", subtitle: "Browse the runtime's built-in guidance." },
  agenttown: { title: "AgentTown", subtitle: "Visualize agent activity in your workspace." },
  memory: { title: "Memory", subtitle: "Review and update the memory files managed by Hermes." },
  system: { title: "System health", subtitle: "Check the runtime and your local machine." },
  settings: { title: "Settings & keys", subtitle: "Manage providers and runtime configuration." },
};

const HERMES_ROUTES: Partial<Record<Page, string>> = {
  assistant: "/chat",
  sessions: "/sessions",
  files: "/files",
  models: "/models",
  logs: "/logs",
  cron: "/cron",
  skills: "/skills",
  plugins: "/plugins",
  mcp: "/mcp",
  pairing: "/pairing",
  channels: "/channels",
  webhooks: "/webhooks",
  docs: "/docs",
};

function getApi(): KnockDeskDesktopAPI | undefined {
  return window.knockdeskAPI;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "An unexpected error occurred.");
}

function statusLabel(state: string | undefined): string {
  switch (state) {
    case "ready": return "Online";
    case "starting": return "Starting";
    case "error": return "Needs attention";
    case "stopped": return "Stopped";
    default: return "Standby";
  }
}

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function EmbeddedView({
  src,
  preload,
  emptyTitle,
  emptyText,
  onError,
}: {
  src: string | null;
  preload?: string | null;
  emptyTitle: string;
  emptyText: string;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !src) return;
    host.replaceChildren();
    const view = document.createElement("webview") as HTMLElement & {
      reload?: () => void;
    };
    view.setAttribute("src", src);
    view.setAttribute("allowpopups", "");
    if (preload) view.setAttribute("preload", preload);
    view.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=yes");
    view.style.width = "100%";
    view.style.height = "100%";
    view.style.display = "inline-flex";

    view.addEventListener("did-fail-load", (event: Event) => {
      const failure = event as Event & { errorDescription?: string; errorCode?: number; isMainFrame?: boolean };
      if (failure.isMainFrame !== false) {
        onError(failure.errorDescription || "The embedded page could not be loaded.");
      }
    });
    view.addEventListener("ipc-message", (event: Event) => {
      const message = event as Event & { channel?: string; args?: unknown[] };
      if (message.channel === "knockdesk ai:open-external") {
        const target = message.args?.[0];
        if (typeof target === "string" && safeUrl(target)) {
          void getApi()?.openExternal(target).catch((error: unknown) => onError(errorMessage(error)));
        }
      }
    });
    host.appendChild(view);
    return () => {
      try { view.remove(); } catch { /* already detached */ }
    };
  }, [src, preload, onError]);

  if (!src) {
    return (
      <div className="empty-state">
        <div className="empty-icon"><Bot size={24} /></div>
        <h3>{emptyTitle}</h3>
        <p>{emptyText}</p>
      </div>
    );
  }
  return <div className="webview-host" ref={hostRef} aria-label={emptyTitle} />;
}

function KnockDeskApp() {
  const [page, setPage] = useState<Page>("home");
  const [runtime, setRuntime] = useState<KnockDeskRuntimeState>({ state: "starting", url: "http://127.0.0.1:9119" });
  const [agentTown, setAgentTown] = useState<KnockDeskAgentTownState>({ state: "idle" });
  const [hermesPreload, setHermesPreload] = useState<string | null>(null);
  const [agentTownPreload, setAgentTownPreload] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [memoryInstruction, setMemoryInstruction] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemBusy, setSystemBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [clock, setClock] = useState(() => new Date());

  const apiAvailable = Boolean(getApi());
  const showError = useCallback((message: string) => setToast({ type: "error", message }), []);
  const title = pageTitles[page];

  const refreshRuntime = useCallback(async () => {
    const api = getApi();
    if (!api) {
      setRuntime({ state: "error", error: "The secure Electron bridge is unavailable." });
      return;
    }
    try {
      const next = await api.getRuntimeState();
      setRuntime(next || { state: "idle" });
      const [hermesPreloadPath, nextAgentTown] = await Promise.all([
        api.getHermesPreloadPath().catch(() => null),
        api.getAgentTownState().catch(() => ({ state: "idle" })),
      ]);
      setHermesPreload(typeof hermesPreloadPath === "string" ? hermesPreloadPath : null);
      setAgentTown(nextAgentTown || { state: "idle" });
      const agentPreloadPath = await api.getAgentTownPreloadPath().catch(() => null);
      setAgentTownPreload(typeof agentPreloadPath === "string" ? agentPreloadPath : null);
    } catch (error) {
      setRuntime({ state: "error", error: errorMessage(error) });
    }
  }, []);

  const refreshMemory = useCallback(async () => {
    try {
      const result = await getApi()?.readMemory();
      setMemory(result || { available: false, memory: "", user: "" });
    } catch (error) {
      setToast({ type: "error", message: errorMessage(error) });
    }
  }, []);

  const refreshSystem = useCallback(async () => {
    setSystemBusy(true);
    try {
      const result = await getApi()?.getSystemInfo();
      setSystemInfo(result && typeof result === "object" ? result as Record<string, unknown> : { details: result });
    } catch (error) {
      setToast({ type: "error", message: errorMessage(error) });
    } finally {
      setSystemBusy(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => { void refreshRuntime(); }, 0);
    const api = getApi();
    const offHermes = api?.onRuntimeState((state: KnockDeskRuntimeState) => setRuntime(state));
    const offAgentTown = api?.onAgentTownState((state: KnockDeskAgentTownState) => setAgentTown(state));
    const offStartupError = api?.onStartupError((message: string) => showError(String(message || "Service initialization failed.")));
    const timer = window.setInterval(() => { void refreshRuntime(); }, 4000);
    const clockTimer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
      window.clearInterval(clockTimer);
      offHermes?.();
      offAgentTown?.();
      offStartupError?.();
    };
  }, [refreshRuntime, showError]);

  useEffect(() => {
    if (toast?.type === "ok" || toast?.type === "info") {
      const timeout = window.setTimeout(() => setToast(null), 4200);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [toast]);

  useEffect(() => {
    const timers: number[] = [];
    if (page === "memory" && !memory) {
      timers.push(window.setTimeout(() => { void refreshMemory(); }, 0));
    }
    if (page === "system" && !systemInfo) {
      timers.push(window.setTimeout(() => { void refreshSystem(); }, 0));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [page, memory, systemInfo, refreshMemory, refreshSystem]);

  const openAssistant = useCallback(async () => {
    setPage("assistant");
    if (runtime.state !== "ready") {
      setToast({ type: "info", message: "The assistant is starting. The chat view will connect when the runtime is ready." });
      try {
        const result = await getApi()?.startRuntime();
        if (result) setRuntime(result as KnockDeskRuntimeState);
      } catch (error) {
        setToast({ type: "error", message: errorMessage(error) });
      }
    }
  }, [runtime.state]);

  const openAgentTown = useCallback(async () => {
    setPage("agenttown");
    if (agentTown.state !== "ready") {
      try {
        const result = await getApi()?.startAgentTown();
        if (result) setAgentTown(result as KnockDeskAgentTownState);
      } catch (error) {
        setToast({ type: "error", message: errorMessage(error) });
      }
    }
  }, [agentTown.state]);

  const submitMemoryInstruction = async () => {
    const instruction = memoryInstruction.trim();
    if (!instruction || memoryBusy) return;
    setMemoryBusy(true);
    try {
      const result = await getApi()?.requestMemory(instruction);
      if (result?.ok === false) throw new Error(result.error || "Memory update was rejected.");
      setMemoryInstruction("");
      setToast({ type: "ok", message: "Memory request sent to Hermes." });
      await refreshMemory();
    } catch (error) {
      setToast({ type: "error", message: errorMessage(error) });
    } finally {
      setMemoryBusy(false);
    }
  };

  const runtimeUrl = useMemo(() => {
    const route = HERMES_ROUTES[page];
    if (!runtime.url || !route) return null;
    try { return new URL(route, runtime.url).toString(); }
    catch { return null; }
  }, [page, runtime.url]);

  const settingsUrl = useMemo(() => {
    if (!runtime.url) return null;
    try { return new URL("/env", runtime.url).toString(); }
    catch { return null; }
  }, [runtime.url]);

  const agentTownUrl = useMemo(() => {
    if (!agentTown.url || agentTown.state !== "ready") return null;
    try { return new URL("/", agentTown.url).toString(); }
    catch { return null; }
  }, [agentTown.url, agentTown.state]);

  const groups = [...new Set(nav.map((item) => item.group))];

  return (
    <div className="kd-app">
      <aside className="kd-sidebar">
        <div className="kd-brand">
          <div className="kd-brand-mark"><Command size={20} strokeWidth={2.3} /></div>
          <div className="kd-brand-copy"><strong>KnockDesk</strong><span>LOCAL AI WORKSPACE</span></div>
        </div>
        <div className="kd-workspace-pill"><span className="pulse-dot" /> Personal workspace <ChevronRight size={14} /></div>
        <nav className="kd-nav" aria-label="Main navigation">
          {groups.map((group) => (
            <div className="kd-nav-group" key={group}>
              <div className="kd-nav-label">{group}</div>
              {nav.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} className={`kd-nav-item ${page === item.id ? "active" : ""}`}
                    onClick={() => {
                      if (item.id === "agenttown") void openAgentTown();
                      else if (item.id === "assistant") void openAssistant();
                      else setPage(item.id);
                    }}>
                    <Icon size={17} strokeWidth={1.9} /><span>{item.label}</span>
                    {item.id === "assistant" && runtime.state === "ready" && <span className="nav-status-dot" />}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="kd-sidebar-bottom">
          <div className="kd-sidebar-runtime">
            <div className={`runtime-indicator ${runtime.state === "ready" ? "online" : runtime.state === "error" ? "error" : "pending"}`} />
            <div className="runtime-copy"><span>Hermes runtime</span><strong>{statusLabel(runtime.state)}</strong></div>
            <button className="icon-button small" title="Refresh runtime status" onClick={() => void refreshRuntime()}><RefreshCw size={14} /></button>
          </div>
          <div className="kd-profile">
            <div className="profile-avatar">K</div>
            <div className="profile-copy"><strong>Local session</strong><span>Private by default</span></div>
            <ShieldCheck size={16} className="profile-shield" />
          </div>
        </div>
      </aside>

      <main className="kd-main">
        <header className="kd-topbar">
          <div className="breadcrumb"><span>KnockDesk</span><ChevronRight size={14} /><strong>{title.title}</strong></div>
          <div className="topbar-actions">
            <div className="local-chip"><span /> LOCAL-FIRST</div>
            <button className="icon-button" title="Refresh runtime" onClick={() => void refreshRuntime()}><RefreshCw size={16} /></button>
            <div className="topbar-clock">{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          </div>
        </header>

        <div className={`kd-content ${["assistant", "sessions", "settings", "agenttown"].includes(page) ? "kd-content-embedded" : ""}`}>
          {page === "home" && (
            <div className="page-enter">
              <section className="welcome-row">
                <div>
                  <div className="eyebrow"><Sparkles size={14} /> YOUR AI WORKSPACE</div>
                  <h1>Make room for <span>deep work.</span></h1>
                  <p className="page-subtitle">{title.subtitle} Your tools, memory, and agent runtime in one place.</p>
                </div>
                <button className="primary-button" onClick={() => void openAssistant()}><MessageSquare size={16} /> Open assistant <ArrowUpRight size={15} /></button>
              </section>

              <section className="status-banner">
                <div className={`banner-symbol ${runtime.state === "ready" ? "positive" : runtime.state === "error" ? "negative" : "waiting"}`}>
                  {runtime.state === "ready" ? <Check size={20} /> : runtime.state === "error" ? <CircleAlert size={20} /> : <LoaderCircle size={20} className="spin" />}
                </div>
                <div className="banner-copy">
                  <strong>{runtime.state === "ready" ? "Your local assistant is ready" : runtime.state === "error" ? "The assistant needs attention" : "Starting your local assistant"}</strong>
                  <span>{runtime.state === "ready" ? "Hermes is responding on this device." : runtime.error || "KnockDesk is checking the local runtime. Your workspace stays open while it starts."}</span>
                </div>
                <div className="banner-actions">
                  <span className={`state-chip ${runtime.state}`}>{statusLabel(runtime.state)}</span>
                  {runtime.state !== "ready" && <button className="text-button" onClick={() => void openAssistant()}>Try again <ChevronRight size={14} /></button>}
                </div>
              </section>

              <section className="metric-grid">
                <article className="metric-card">
                  <div className="metric-icon cyan"><Bot size={18} /></div>
                  <div className="metric-top"><span>AI runtime</span><span className="metric-indicator" /></div>
                  <strong className="metric-value">{statusLabel(runtime.state)}</strong>
                  <span className="metric-caption">Hermes agent service</span>
                </article>
                <article className="metric-card">
                  <div className="metric-icon violet"><Brain size={18} /></div>
                  <div className="metric-top"><span>Long-term memory</span></div>
                  <strong className="metric-value">Available locally</strong>
                  <span className="metric-caption">Review files and submit updates</span>
                </article>
                <article className="metric-card">
                  <div className="metric-icon amber"><Network size={18} /></div>
                  <div className="metric-top"><span>AgentTown</span></div>
                  <strong className="metric-value">{statusLabel(agentTown.state)}</strong>
                  <span className="metric-caption">Agent activity visualizer</span>
                </article>
                <article className="metric-card">
                  <div className="metric-icon green"><ShieldCheck size={18} /></div>
                  <div className="metric-top"><span>Execution mode</span></div>
                  <strong className="metric-value">On-device</strong>
                  <span className="metric-caption">Provider requests use configured endpoints</span>
                </article>
              </section>

              <section className="home-lower-grid">
                <div className="panel-card">
                  <div className="panel-heading"><div><h2>Quick actions</h2><p>Pick up where you left off.</p></div><Zap size={17} /></div>
                  <div className="quick-action-list">
                    <button className="quick-action" onClick={() => void openAssistant()}><span className="quick-icon"><MessageSquare size={17} /></span><span><strong>Start a conversation</strong><small>Open your AI assistant</small></span><ChevronRight size={16} /></button>
                    <button className="quick-action" onClick={() => { setPage("memory"); void refreshMemory(); }}><span className="quick-icon"><Brain size={17} /></span><span><strong>Review your memory</strong><small>See what the assistant remembers</small></span><ChevronRight size={16} /></button>
                    <button className="quick-action" onClick={() => setPage("settings")}><span className="quick-icon"><Settings2 size={17} /></span><span><strong>Configure providers</strong><small>Manage API keys and settings</small></span><ChevronRight size={16} /></button>
                    <button className="quick-action" onClick={() => { setPage("system"); void refreshSystem(); }}><span className="quick-icon"><Gauge size={17} /></span><span><strong>Check system health</strong><small>Inspect this device's runtime</small></span><ChevronRight size={16} /></button>
                  </div>
                </div>
                <div className="panel-card">
                  <div className="panel-heading"><div><h2>Workspace status</h2><p>Services on this device.</p></div><Activity size={17} /></div>
                  <div className="service-list">
                    <div className="service-row"><span className="service-symbol"><Cpu size={16} /></span><span className="service-copy"><strong>Hermes dashboard</strong><small>{runtime.url || "Local service URL pending"}</small></span><span className={`service-state ${runtime.state}`}>{statusLabel(runtime.state)}</span></div>
                    <div className="service-row"><span className="service-symbol"><Network size={16} /></span><span className="service-copy"><strong>AgentTown visualizer</strong><small>{agentTown.url || "Starts when opened"}</small></span><span className={`service-state ${agentTown.state}`}>{statusLabel(agentTown.state)}</span></div>
                    <div className="service-row"><span className="service-symbol"><HardDrive size={16} /></span><span className="service-copy"><strong>Local data</strong><small>Managed by KnockDesk and Hermes</small></span><span className="service-state ready">On device</span></div>
                  </div>
                  <div className="privacy-note"><ShieldCheck size={16} /><span>Local storage stays on this device. Requests to AI providers use the provider you configure.</span></div>
                </div>
              </section>
              <footer className="page-footer"><span>KnockDesk · Local AI workspace</span><span><span className="footer-dot" /> Runtime-aware · Privacy-minded</span></footer>
            </div>
          )}

          {(["assistant", "sessions", "files", "models", "logs", "cron", "skills", "plugins", "mcp", "pairing", "channels", "webhooks", "docs"] as Page[]).includes(page) && (
            <div className="embedded-page">
              <div className="embedded-toolbar"><div><span className="eyebrow"><MessageSquare size={13} /> HERMES WORKSPACE</span><h1>{title.title}</h1></div><button className="secondary-button" onClick={() => void refreshRuntime()}><RefreshCw size={14} /> Refresh status</button></div>
              {runtime.state === "error" && <div className="inline-alert"><CircleAlert size={16} /><span>{runtime.error || "The Hermes runtime is unavailable."}</span><button onClick={() => void openAssistant()}>Restart</button></div>}
              <EmbeddedView key={page} src={runtime.state === "ready" ? runtimeUrl : null} preload={hermesPreload}
                emptyTitle={runtime.state === "error" ? "Runtime unavailable" : "Assistant is starting"}
                emptyText={runtime.error || "This panel connects to the local Hermes dashboard when the runtime reports ready."}
                onError={showError} />
            </div>
          )}

          {page === "agenttown" && (
            <div className="embedded-page">
              <div className="embedded-toolbar"><div><span className="eyebrow"><Network size={13} /> VISUALIZER</span><h1>AgentTown</h1></div><button className="secondary-button" onClick={() => void openAgentTown()}><RefreshCw size={14} /> Start / refresh</button></div>
              <EmbeddedView src={agentTownUrl} preload={agentTownPreload}
                emptyTitle={agentTown.state === "error" ? "AgentTown could not start" : "AgentTown is starting"}
                emptyText={agentTown.error || "Open this view to start the local visualizer. Its agent protocol connection depends on the installed runtime integration."}
                onError={(message) => setToast({ type: "error", message })} />
            </div>
          )}

          {page === "memory" && (
            <div className="page-enter section-page">
              <div className="section-intro"><div className="eyebrow"><Brain size={14} /> PERSONAL CONTEXT</div><h1>Memory & notes</h1><p className="page-subtitle">Read the memory surfaced by Hermes, or send an instruction for it to evaluate.</p></div>
              <div className="memory-grid">
                <section className="panel-card memory-panel"><div className="panel-heading"><div><h2>Assistant memory</h2><p>MEMORY.md</p></div><button className="icon-button" title="Reload memory" onClick={() => void refreshMemory()}><RefreshCw size={15} /></button></div><pre className="memory-content">{memory?.memory?.trim() || "No memory content is available yet."}</pre></section>
                <section className="panel-card memory-panel"><div className="panel-heading"><div><h2>About you</h2><p>USER.md</p></div><FileText size={17} /></div><pre className="memory-content">{memory?.user?.trim() || "No user profile is available yet."}</pre></section>
              </div>
              {memory?.available === false && <div className="inline-alert"><CircleAlert size={16} /><span>Memory files are not available until the Hermes runtime is installed and ready.</span></div>}
              <section className="panel-card memory-request"><div className="panel-heading"><div><h2>Ask Hermes to update memory</h2><p>Send a natural-language request; Hermes evaluates and handles the change.</p></div><Sparkles size={18} /></div><textarea value={memoryInstruction} onChange={(event) => setMemoryInstruction(event.target.value)} placeholder="For example: remember that I prefer concise project updates." rows={3} /><div className="form-actions"><span>Only send information you are comfortable storing in local memory.</span><button className="primary-button" disabled={!memoryInstruction.trim() || memoryBusy || runtime.state !== "ready"} onClick={() => void submitMemoryInstruction()}>{memoryBusy ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />} Send request</button></div></section>
            </div>
          )}

          {page === "settings" && (
            <div className="embedded-page">
              <div className="embedded-toolbar"><div><span className="eyebrow"><Settings2 size={13} /> CONFIGURATION</span><h1>Settings & keys</h1></div><a className="text-link" href="https://hermes-agent.nousresearch.com/" target="_blank" rel="noreferrer">Hermes docs <ExternalLink size={13} /></a></div>
              <div className="settings-warning"><ShieldCheck size={17} /><span>Provider credentials are handled by the local Hermes dashboard. Configure only keys you own or are authorized to use.</span></div>
              <EmbeddedView src={settingsUrl} preload={hermesPreload}
                emptyTitle="Settings are unavailable" emptyText="Start the Hermes runtime to manage provider settings."
                onError={(message) => setToast({ type: "error", message })} />
            </div>
          )}

          {page === "system" && (
            <div className="page-enter section-page">
              <div className="section-intro"><div className="eyebrow"><Activity size={14} /> DIAGNOSTICS</div><h1>System health</h1><p className="page-subtitle">Runtime and device information gathered through the Electron main process.</p></div>
              <div className="system-summary-grid">
                <div className="panel-card system-summary"><span className="system-summary-icon"><Bot size={18} /></span><span>Hermes runtime</span><strong>{statusLabel(runtime.state)}</strong><small>{runtime.error || runtime.url || "Local runtime has not reported a URL."}</small></div>
                <div className="panel-card system-summary"><span className="system-summary-icon"><Network size={18} /></span><span>AgentTown</span><strong>{statusLabel(agentTown.state)}</strong><small>{agentTown.error || agentTown.url || "Starts on demand."}</small></div>
              </div>
              <section className="panel-card diagnostics-panel"><div className="panel-heading"><div><h2>Device report</h2><p>System details from the local service.</p></div><button className="secondary-button" disabled={systemBusy} onClick={() => void refreshSystem()}>{systemBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button></div>
                {systemInfo ? <dl className="diagnostic-list">{Object.entries(systemInfo).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ")}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</dd></div>)}</dl> : <div className="empty-state compact"><Gauge size={22} /><p>{systemBusy ? "Collecting system information…" : "No system report loaded."}</p></div>}
              </section>
              <section className="panel-card diagnostics-panel"><div className="panel-heading"><div><h2>Runtime details</h2><p>Information useful when diagnosing startup problems.</p></div><Terminal size={17} /></div><dl className="diagnostic-list"><div><dt>State</dt><dd>{runtime.state}</dd></div><div><dt>Local URL</dt><dd>{runtime.url || "—"}</dd></div><div><dt>Port</dt><dd>{runtime.port || "—"}</dd></div><div><dt>Error</dt><dd>{runtime.error || "None reported"}</dd></div><div><dt>Remote integration readiness</dt><dd>{runtime.knockdeskReady ? "Ready" : runtime.knockdeskPending ? "Setting up" : "Not ready / not enabled"}</dd></div></dl></section>
            </div>
          )}
        </div>
      </main>
      {toast && <div role="status" className={`toast ${toast.type}`}>{toast.type === "ok" ? <Check size={16} /> : toast.type === "error" ? <CircleAlert size={16} /> : <Clock3 size={16} />}{toast.message}<button aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div>}
      {!apiAvailable && <div className="fatal-overlay"><div className="fatal-card"><CircleAlert size={28} /><h2>Desktop bridge unavailable</h2><p>This renderer must run inside KnockDesk Electron so its secure IPC bridge is available.</p></div></div>}
    </div>
  );
}

export default KnockDeskApp;
