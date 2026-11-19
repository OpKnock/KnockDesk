/**
 * Local stand-in for the `@hermes/shared` workspace package.
 *
 * The shipped monorepo keeps the JSON-RPC-over-WebSocket transport in
 * `apps/shared`; this checkout only carries `web/`, so the package import
 * would not resolve here. This module provides the exact surface the
 * dashboard sources use (`JsonRpcGatewayClient`,
 * `buildHermesWebSocketUrl`, plus the shared protocol types) with a
 * faithful newline-delimited JSON-RPC implementation, so `npm run build`
 * and the running app both work from this tree alone.
 */

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type GatewayEventName = string;

export interface GatewayEvent<T = unknown> {
  method: string;
  payload?: T;
}

export interface JsonRpcGatewayClientOptions {
  closedErrorMessage?: string;
  connectErrorMessage?: string;
  notConnectedErrorMessage?: string;
  requestIdPrefix?: string;
}

export interface BuildWsUrlOptions {
  authParam: readonly [string, string];
  basePath: string;
  params?: Record<string, string>;
  path: string;
}

/** Build an absolute `ws(s)://` URL for a dashboard WebSocket endpoint. */
export function buildHermesWebSocketUrl(opts: BuildWsUrlOptions): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = (opts.basePath || '').replace(/\/$/, '');
  const query = new URLSearchParams({
    ...(opts.params ?? {}),
    [opts.authParam[0]]: opts.authParam[1],
  });
  return `${proto}//${loc.host}${base}${opts.path}?${query.toString()}`;
}

type StateHandler = (state: ConnectionState) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEventHandler = (ev: GatewayEvent<any>) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Newline-delimited JSON-RPC 2.0 client over a browser WebSocket.
 *
 * Speaks the same dialect the Ink TUI drives over stdio: requests carry
 * `{ jsonrpc: "2.0", id, method, params }`, server replies resolve by
 * `id`, and anything with a `method` but no known `id` is dispatched as
 * a notification to `on()` subscribers.
 */
export class JsonRpcGatewayClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly eventHandlers = new Map<string, Set<AnyEventHandler>>();
  private readonly pending = new Map<string | number, PendingCall>();
  private buffer = '';
  private seq = 0;
  private readonly closedErrorMessage: string;
  private readonly connectErrorMessage: string;
  private readonly notConnectedErrorMessage: string;
  private readonly requestIdPrefix: string;

  constructor(opts: JsonRpcGatewayClientOptions = {}) {
    this.closedErrorMessage = opts.closedErrorMessage ?? 'WebSocket closed';
    this.connectErrorMessage = opts.connectErrorMessage ?? 'WebSocket connection failed';
    this.notConnectedErrorMessage = opts.notConnectedErrorMessage ?? 'gateway not connected';
    this.requestIdPrefix = opts.requestIdPrefix ?? 'w';
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Subscribe to connection-state transitions. Returns an unsubscribe fn. */
  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /** Subscribe to server notifications for one method. Returns unsubscribe. */
  on<T>(event: string, handler: (ev: GatewayEvent<T>) => void): () => void {
    const wrapped = handler as AnyEventHandler;
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  /** Open the socket. Resolves once open, rejects on immediate failure. */
  connect(url: string): Promise<void> {
    if (this.socket && (this.state === 'open' || this.state === 'connecting')) {
      return Promise.resolve();
    }
    this.setState('connecting');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this.setState('error');
        reject(err instanceof Error ? err : new Error(this.connectErrorMessage));
        return;
      }
      this.socket = ws;
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        this.setState('open');
        resolve();
      };
      ws.onmessage = (msg) => {
        this.ingest(String(msg.data ?? ''));
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          this.setState('error');
          reject(new Error(this.connectErrorMessage));
        }
      };
      ws.onclose = () => {
        this.socket = null;
        this.failAllPending(new Error(this.closedErrorMessage));
        if (this.state !== 'error') {
          this.setState('closed');
        }
      };
    });
  }

  /** Send a request and resolve with the server's `result`. */
  request<T>(method: string, params?: unknown): Promise<T> {
    const ws = this.socket;
    if (!ws || this.state !== 'open') {
      return Promise.reject(new Error(this.notConnectedErrorMessage));
    }
    this.seq += 1;
    const id = `${this.requestIdPrefix}${this.seq}`;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      payload['params'] = params;
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      ws.send(JSON.stringify(payload));
    });
  }

  /** Close the socket and fail any in-flight requests. */
  close(): void {
    const ws = this.socket;
    this.socket = null;
    this.failAllPending(new Error(this.closedErrorMessage));
    try {
      ws?.close();
    } catch {
      // Already gone — state below still applies.
    }
    if (this.state === 'open' || this.state === 'connecting') {
      this.setState('closed');
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const handler of [...this.stateHandlers]) {
      try {
        handler(next);
      } catch {
        // A failing subscriber must never break the client.
      }
    }
  }

  private failAllPending(err: Error): void {
    if (this.pending.size === 0) return;
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      try {
        call.reject(err);
      } catch {
        // Ignore subscriber teardown failures.
      }
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    // The last segment may be an incomplete frame — hold it back.
    this.buffer = parts.pop() ?? '';
    for (const part of parts) {
      const text = part.trim();
      if (text === '') continue;
      this.dispatchText(text);
    }
    // Also handle a complete single frame with no trailing newline yet.
    const rest = this.buffer.trim();
    if (rest !== '' && (rest.startsWith('{') || rest.startsWith('['))) {
      try {
        const parsed: unknown = JSON.parse(rest);
        this.buffer = '';
        this.dispatch(parsed);
      } catch {
        // Still incomplete — keep buffering.
      }
    }
  }

  private dispatchText(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    this.dispatch(parsed);
  }

  private dispatch(msg: unknown): void {
    if (Array.isArray(msg)) {
      for (const item of msg) this.dispatch(item);
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const record = msg as Record<string, unknown>;

    if ('id' in record && (typeof record['id'] === 'string' || typeof record['id'] === 'number')) {
      const call = this.pending.get(record['id'] as string | number);
      if (call) {
        this.pending.delete(record['id'] as string | number);
        if ('error' in record && record['error'] != null) {
          const detail =
            typeof record['error'] === 'object' && record['error'] !== null
              ? String((record['error'] as Record<string, unknown>)['message'] ?? 'request failed')
              : String(record['error']);
          call.reject(new Error(detail));
        } else {
          call.resolve(record['result']);
        }
        return;
      }
    }

    if (typeof record['method'] === 'string') {
      const subs = this.eventHandlers.get(record['method'] as string);
      if (!subs || subs.size === 0) return;
      const ev: GatewayEvent<unknown> = {
        method: record['method'] as string,
        payload: ('params' in record ? record['params'] : undefined) as unknown,
      };
      for (const handler of [...subs]) {
        try {
          handler(ev);
        } catch {
          // A failing subscriber must never break dispatch.
        }
      }
    }
  }
}
