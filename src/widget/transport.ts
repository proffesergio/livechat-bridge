/**
 * `ChatTransport` — the visitor widget's realtime pipe.
 *
 * The widget is embedded on third-party pages we do not control: corporate
 * proxies strip WebSocket upgrades, some CDNs buffer them, and a chunk of
 * traffic sits behind captive portals. So the transport is WebSocket-*first*,
 * never WebSocket-*only* — every failure path lands on the HTTP long-poll
 * fallback rather than on an error state. `polling` is a healthy state.
 *
 * The two wires carry the exact same `RealtimeEnvelope`, and every envelope
 * carries a monotonic `seq`. That single field is what makes switching
 * transports lossless: whichever wire we open next resumes from the last `seq`
 * we saw, and anything at or below the cursor is dropped as a replay. Callers
 * therefore never observe a gap *or* a duplicate, no matter how often the
 * connection flaps.
 *
 * This module is framework-free on purpose — no React, no DOM globals captured
 * at import time. `WebSocket` and `fetch` are constructor-injectable so the
 * whole state machine can be exercised in plain Node with fakes.
 */

import type {
  Attachment,
  Conversation,
  ConnectionState,
  CreateSessionRequest,
  Message,
  RealtimeEnvelope,
  RealtimeEnvelopeFor,
  SendMessageRequest,
  ServerEventMap,
  ServerEventName,
  SessionResponse,
  TransportOptions,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Injectable environment                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the WebSocket API we actually use.
 *
 * Deliberately structural rather than `lib.dom`'s `WebSocket`: a test fake is a
 * ten-line class, and nothing here depends on a browser being present.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WebSocketFactory = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Minimal `Response`; only the members the transport reads. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  /** `string` for JSON, `FormData` for uploads — kept opaque to avoid DOM types. */
  body?: unknown;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: RequestInitLike) => Promise<HttpResponseLike>;

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChatTransportOptions extends TransportOptions {
  /** Resume target. May be set later via `setConversation` once one exists. */
  conversationId?: string;
  /** Resume cursor from a previous page load. `0` means "nothing seen yet". */
  since?: number;

  /** First reconnect delay, doubled per attempt. Default 500. */
  baseBackoffMs?: number;
  /**
   * How long a socket must stay up before we call it healthy and forget the
   * accumulated backoff. Without this a server that accepts and instantly drops
   * connections would be hammered at the floor delay forever. Default 10_000.
   */
  healthyAfterMs?: number;
  /**
   * Floor between poll cycles when the server answers immediately with nothing.
   * A long-poll that does not actually hold the request open would otherwise
   * spin the client at full speed. Default 1_000.
   */
  pollIdleDelayMs?: number;

  WebSocketImpl?: WebSocketFactory | undefined;
  fetchImpl?: FetchLike | undefined;
  /** Injectable for deterministic backoff in tests. */
  random?: () => number;
  now?: () => number;
}

/** Frames the widget sends up the socket. Everything else goes over HTTP. */
export type ClientFrame =
  | { type: 'resume'; conversationId?: string; after: number }
  | { type: 'typing'; conversationId: string }
  | { type: 'read'; conversationId: string; seq: number };

export type EnvelopeListener<E extends ServerEventName> = (
  data: ServerEventMap[E],
  envelope: RealtimeEnvelopeFor<E>,
) => void;

type AnyEnvelopeListener = (data: never, envelope: RealtimeEnvelope) => void;

const DEFAULTS = {
  maxBackoffMs: 30_000,
  pollTimeoutMs: 25_000,
  baseBackoffMs: 500,
  healthyAfterMs: 10_000,
  pollIdleDelayMs: 1_000,
} as const;

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export class ChatTransport {
  readonly baseUrl: string;
  readonly socketUrl: string | undefined;

  private token: string;
  private conversationId: string | undefined;

  private readonly maxBackoffMs: number;
  private readonly pollTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly healthyAfterMs: number;
  private readonly pollIdleDelayMs: number;

  private readonly WebSocketImpl: WebSocketFactory | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly random: () => number;
  private readonly now: () => number;

  /** Last `seq` handed to subscribers. The resume cursor and the dedup guard. */
  private lastSeq: number;

  private state: ConnectionState = 'idle';
  private closed = false;
  private started = false;

  private socket: WebSocketLike | null = null;
  private socketOpenedAt = 0;

  private wsAttempt = 0;
  private pollAttempt = 0;

  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private pollWaitResolve: (() => void) | null = null;
  private pollAbort: AbortController | null = null;
  private pollActive = false;
  /**
   * Monotonic generation token for the poll loop. Bumping it makes any loop
   * still in flight fall out on its next iteration instead of racing the new
   * one — awaited fetches cannot be un-awaited, only ignored.
   */
  private pollGen = 0;

  private readonly listeners = new Map<ServerEventName, Set<AnyEnvelopeListener>>();
  private readonly anyListeners = new Set<(envelope: RealtimeEnvelope) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(options: ChatTransportOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.socketUrl = options.socketUrl;
    this.token = options.token;
    this.conversationId = options.conversationId;
    this.lastSeq = options.since ?? 0;

    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULTS.pollTimeoutMs;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.healthyAfterMs = options.healthyAfterMs ?? DEFAULTS.healthyAfterMs;
    this.pollIdleDelayMs = options.pollIdleDelayMs ?? DEFAULTS.pollIdleDelayMs;

    this.WebSocketImpl =
      options.WebSocketImpl ??
      (globalThis as { WebSocket?: WebSocketFactory }).WebSocket ??
      undefined;
    this.fetchImpl =
      options.fetchImpl ??
      ((globalThis as { fetch?: unknown }).fetch as FetchLike | undefined) ??
      undefined;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /* ---------------------------------------------------------------------- */
  /* Public surface                                                          */
  /* ---------------------------------------------------------------------- */

  getState(): ConnectionState {
    return this.state;
  }

  /** Highest `seq` delivered so far — persist it to resume across reloads. */
  getCursor(): number {
    return this.lastSeq;
  }

  /** Idempotent: calling `connect()` twice does not open two sockets. */
  connect(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.openBestTransport();
  }

  /**
   * Point the transport at a conversation (or a different one).
   *
   * A `seq` cursor is per-conversation, so switching resets it and restarts
   * whichever wire is live — otherwise the new conversation's early events
   * would look like replays of the old one's and be dropped.
   */
  setConversation(conversationId: string | undefined, since = 0): void {
    if (this.conversationId === conversationId) return;
    this.conversationId = conversationId;
    this.lastSeq = since;
    if (this.closed || !this.started) return;

    if (this.socket && this.state === 'open') {
      this.sendFrame({ type: 'resume', conversationId, after: this.lastSeq });
    } else if (this.state === 'polling') {
      this.restartPolling();
    }
  }

  /** Swap in a refreshed session token; reconnects so the new one is used. */
  setToken(token: string): void {
    this.token = token;
    if (this.closed || !this.started) return;
    this.teardownSocket();
    this.stopPolling();
    this.openBestTransport();
  }

  on<E extends ServerEventName>(event: E, listener: EnvelopeListener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as unknown as AnyEnvelopeListener;
    set.add(entry);
    return () => {
      set?.delete(entry);
    };
  }

  /** Every envelope, in cursor order. Useful for a single reducer. */
  onAny(listener: (envelope: RealtimeEnvelope) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Non-fatal transport errors. The state machine keeps retrying regardless. */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /**
   * Release everything: socket, in-flight poll, and both timers. After this the
   * transport is inert — late socket callbacks and late fetch settlements are
   * ignored rather than scheduling more work.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownSocket();
    this.stopPolling();
    if (this.wsRetryTimer !== null) {
      clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
    this.setState('closed');
    this.listeners.clear();
    this.anyListeners.clear();
    this.errorListeners.clear();
    // State listeners survive one more beat above, then go.
    this.stateListeners.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP API (the widget's write path — sends never ride the fallback poll)  */
  /* ---------------------------------------------------------------------- */

  async sendMessage(request: SendMessageRequest): Promise<Message> {
    const body = await this.request<{ message?: Message } | Message>('POST', '/messages', request);
    const message = (body as { message?: Message }).message ?? (body as Message);
    if (!message || typeof message.id !== 'string') {
      throw new Error('Malformed /messages response: no message');
    }
    return message;
  }

  /**
   * Typing is best-effort and high-frequency, so it prefers the already-open
   * socket and only falls back to HTTP while polling. Failures are swallowed —
   * a dropped typing ping is never worth surfacing to the visitor.
   */
  sendTyping(conversationId: string): void {
    if (this.sendFrame({ type: 'typing', conversationId })) return;
    void this.request('POST', '/typing', { conversationId }).catch(() => undefined);
  }

  async fetchMessages(conversationId: string, after = 0, limit = 50): Promise<Message[]> {
    const query = `?conversationId=${encodeURIComponent(conversationId)}&after=${after}&limit=${limit}`;
    const body = await this.request<{ items?: Message[] } | Message[]>('GET', `/messages${query}`);
    return Array.isArray(body) ? body : (body.items ?? []);
  }

  // No `closeConversation` here on purpose: closing is an agent action
  // (`POST /conversations/:id/close` requires `authenticateAgent`), so a
  // visitor-side method would only ever return 401. Visitors leave a resolved
  // chat via "Start a new conversation", which opens a fresh one instead.

  /** `file` is a browser `File`/`Blob`; kept opaque so this file stays DOM-free. */
  async uploadAttachment(conversationId: string, file: unknown, name: string): Promise<Attachment> {
    const FormDataImpl = (globalThis as { FormData?: new () => { append(k: string, v: unknown, n?: string): void } })
      .FormData;
    if (!FormDataImpl) throw new Error('FormData is unavailable in this runtime');
    const form = new FormDataImpl();
    form.append('conversationId', conversationId);
    form.append('file', file, name);
    const body = await this.request<{ attachment?: Attachment } | Attachment>(
      'POST',
      '/upload',
      form,
    );
    const attachment = (body as { attachment?: Attachment }).attachment ?? (body as Attachment);
    if (!attachment || typeof attachment.url !== 'string') {
      throw new Error('Malformed /upload response: no attachment');
    }
    return attachment;
  }

  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) throw new Error('No fetch implementation available');

    const isForm = payload !== undefined && !isPlainPayload(payload);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (payload !== undefined && !isForm) headers['Content-Type'] = 'application/json';

    const init: RequestInitLike = { method, headers };
    if (payload !== undefined) init.body = isForm ? payload : JSON.stringify(payload);

    const res = await fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}`);
    return (await res.json()) as T;
  }

  /* ---------------------------------------------------------------------- */
  /* Transport selection                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Prefer the socket; fall straight to polling when there is no socket URL or
   * no `WebSocket` implementation in this runtime.
   */
  private openBestTransport(): void {
    if (this.closed) return;
    if (this.socketUrl && this.WebSocketImpl) {
      this.openSocket();
      return;
    }
    this.startPolling();
  }

  private openSocket(): void {
    if (this.closed) return;
    const Impl = this.WebSocketImpl;
    const url = this.socketUrl;
    if (!Impl || !url) {
      this.startPolling();
      return;
    }

    this.clearWsRetry();
    // Only announce `connecting` from a cold start. While polling we stay in
    // `polling` until the socket is actually up, so an upgrade attempt never
    // makes a working connection look broken to the UI.
    if (this.state !== 'polling') this.setState('connecting');

    let socket: WebSocketLike;
    try {
      // Browsers cannot set headers on a WebSocket handshake, so the token
      // rides the query string; the resume cursor goes in the first frame.
      socket = new Impl(this.socketUrlWithAuth(url));
    } catch (error) {
      this.reportError(error);
      this.handleSocketFailure();
      return;
    }

    this.socket = socket;
    this.socketOpenedAt = 0;

    socket.onopen = () => {
      if (this.closed || this.socket !== socket) return;
      this.socketOpenedAt = this.now();
      // The socket is authoritative once open: stop the fallback poll so the
      // same envelopes are not fetched twice (dedup would drop them anyway,
      // but an idle HTTP request per cycle is pure waste).
      this.stopPolling();
      this.clearWsRetry();
      this.setState('open');
      this.sendFrame({ type: 'resume', conversationId: this.conversationId, after: this.lastSeq });
    };

    socket.onmessage = (event) => {
      if (this.closed || this.socket !== socket) return;
      this.ingest(event.data);
    };

    socket.onerror = (event) => {
      if (this.closed || this.socket !== socket) return;
      this.reportError(event instanceof Error ? event : new Error('WebSocket error'));
    };

    socket.onclose = () => {
      // A socket we tore down ourselves is detached first, so this guard also
      // covers "the peer closed after we already moved on".
      if (this.closed || this.socket !== socket) return;
      this.socket = null;

      // A connection that lasted counts as proof the socket path works, so the
      // accumulated backoff is forgiven — this flap starts from the floor.
      if (this.socketOpenedAt && this.now() - this.socketOpenedAt >= this.healthyAfterMs) {
        this.wsAttempt = 0;
      }
      this.handleSocketFailure();
    };
  }

  /**
   * Every socket failure resolves the same way: cover the gap with long-poll
   * *now*, and schedule the next socket attempt on a jittered backoff. Polling
   * is not a punishment state — it is what keeps messages flowing while the
   * socket path is retried in the background.
   */
  private handleSocketFailure(): void {
    if (this.closed) return;
    this.wsAttempt += 1;
    this.startPolling();

    if (!this.socketUrl || !this.WebSocketImpl) return;
    this.clearWsRetry();
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      this.openSocket();
    }, this.backoff(this.wsAttempt));
  }

  private socketUrlWithAuth(url: string): string {
    const sep = url.includes('?') ? '&' : '?';
    let out = `${url}${sep}token=${encodeURIComponent(this.token)}&after=${this.lastSeq}`;
    if (this.conversationId) out += `&conversationId=${encodeURIComponent(this.conversationId)}`;
    return out;
  }

  private sendFrame(frame: ClientFrame): boolean {
    const socket = this.socket;
    if (!socket || this.state !== 'open') return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpenedAt = 0;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, 'client closed');
    } catch {
      // A half-constructed socket can throw here; nothing left to do about it.
    }
  }

  private clearWsRetry(): void {
    if (this.wsRetryTimer !== null) {
      clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Long-poll fallback                                                      */
  /* ---------------------------------------------------------------------- */

  private startPolling(): void {
    if (this.closed) return;
    this.setState('polling');
    if (this.pollActive) return;
    this.pollActive = true;
    void this.pollLoop(++this.pollGen);
  }

  private restartPolling(): void {
    this.stopPolling();
    this.startPolling();
  }

  private stopPolling(): void {
    this.pollActive = false;
    // Invalidate rather than reset: a loop awaiting a fetch must never be able
    // to match a future generation and resurrect itself.
    this.pollGen += 1;
    if (this.pollWaitTimer !== null) {
      clearTimeout(this.pollWaitTimer);
      this.pollWaitTimer = null;
    }
    // Resolve rather than leak: the loop wakes, sees a stale generation, exits.
    const resolve = this.pollWaitResolve;
    this.pollWaitResolve = null;
    resolve?.();
    const abort = this.pollAbort;
    this.pollAbort = null;
    abort?.abort();
  }

  private async pollLoop(generation: number): Promise<void> {
    while (!this.closed && this.pollGen === generation) {
      const startedAt = this.now();
      let empty = true;

      const abort = new AbortController();
      this.pollAbort = abort;
      try {
        const fetchImpl = this.fetchImpl;
        if (!fetchImpl) throw new Error('No fetch implementation available');

        const res = await fetchImpl(this.pollUrl(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}` },
          signal: abort.signal,
        });
        if (this.closed || this.pollGen !== generation) return;
        if (!res.ok) throw new Error(`Poll failed with ${res.status}`);

        const body = await res.json();
        if (this.closed || this.pollGen !== generation) return;
        empty = this.ingest(body) === 0;
        this.pollAttempt = 0;
      } catch (error) {
        if (this.closed || this.pollGen !== generation || abort.signal.aborted) return;
        this.pollAttempt += 1;
        this.reportError(error);
        await this.wait(this.backoff(this.pollAttempt), generation);
        continue;
      } finally {
        if (this.pollAbort === abort) this.pollAbort = null;
      }

      // Guard against a server that answers the "long" poll instantly: without
      // a floor an empty fast response would spin this loop at full speed.
      if (empty && this.now() - startedAt < this.pollTimeoutMs / 2) {
        await this.wait(this.pollIdleDelayMs, generation);
      }
    }
  }

  private pollUrl(): string {
    const params = [`after=${this.lastSeq}`, `timeout=${this.pollTimeoutMs}`];
    if (this.conversationId) {
      params.unshift(`conversationId=${encodeURIComponent(this.conversationId)}`);
    }
    return `${this.baseUrl}/poll?${params.join('&')}`;
  }

  /** Cancellable sleep — `stopPolling()`/`close()` resolve it immediately. */
  private wait(ms: number, generation: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.closed || this.pollGen !== generation) {
        resolve();
        return;
      }
      this.pollWaitResolve = resolve;
      this.pollWaitTimer = setTimeout(() => {
        this.pollWaitTimer = null;
        this.pollWaitResolve = null;
        resolve();
      }, ms);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Envelope ingestion                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Normalises whatever arrived (a frame, an array, or `{ events: [...] }`),
   * drops replays, advances the cursor and fans out. Returns how many
   * envelopes were actually delivered so the poll loop can tell "nothing
   * happened" from "a batch arrived".
   */
  private ingest(payload: unknown): number {
    let delivered = 0;
    for (const envelope of extractEnvelopes(payload)) {
      const seq = envelope.seq;
      if (typeof seq === 'number' && Number.isFinite(seq)) {
        // The cursor is monotonic, so anything at or below it is a replay from
        // a resume — the whole point of the WS/poll handover.
        if (seq <= this.lastSeq) continue;
        this.lastSeq = seq;
      }
      delivered += 1;
      this.dispatch(envelope);
    }
    return delivered;
  }

  private dispatch(envelope: RealtimeEnvelope): void {
    const set = this.listeners.get(envelope.event);
    if (set) {
      for (const listener of [...set]) {
        try {
          (listener as (data: unknown, env: RealtimeEnvelope) => void)(envelope.data, envelope);
        } catch (error) {
          this.reportError(error);
        }
      }
    }
    for (const listener of [...this.anyListeners]) {
      try {
        listener(envelope);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Misc                                                                    */
  /* ---------------------------------------------------------------------- */

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(next);
      } catch {
        // A broken state listener must not take the connection down with it.
      }
    }
  }

  private reportError(error: unknown): void {
    if (this.errorListeners.size === 0) return;
    const err = error instanceof Error ? error : new Error(String(error));
    for (const listener of [...this.errorListeners]) {
      try {
        listener(err);
      } catch {
        // ignored
      }
    }
  }

  /**
   * Exponential backoff with equal jitter: half the delay is fixed, half is
   * random. Full jitter would let a retry fire almost immediately; none at all
   * would make every widget on a site reconnect in lockstep after an outage.
   */
  private backoff(attempt: number): number {
    const exponential = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.round(exponential / 2 + this.random() * (exponential / 2));
  }
}

/* -------------------------------------------------------------------------- */
/* Session bootstrap                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `POST /session` — must happen before a transport exists, because the token
 * and the (optional) `socketUrl` both come out of it. Anonymous visitors get a
 * minted `visitorId`; a host that vouches for its user passes `identity` plus
 * the HMAC that proves the host signed it.
 */
export async function createSession(
  baseUrl: string,
  request: CreateSessionRequest,
  fetchImpl?: FetchLike,
): Promise<SessionResponse> {
  const impl =
    fetchImpl ?? ((globalThis as { fetch?: unknown }).fetch as FetchLike | undefined) ?? undefined;
  if (!impl) throw new Error('No fetch implementation available');

  const res = await impl(`${stripTrailingSlash(baseUrl)}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`POST /session failed with ${res.status}`);
  const body = (await res.json()) as SessionResponse;
  if (!body || typeof body.token !== 'string') {
    throw new Error('Malformed /session response: no token');
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** JSON-serialisable payloads go out as JSON; anything else is a FormData body. */
function isPlainPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return true;
  const proto = Object.getPrototypeOf(payload) as object | null;
  return proto === Object.prototype || proto === null || Array.isArray(payload);
}

/**
 * Both wires may deliver a lone envelope, a batch, or a `{ events: [...] }`
 * body, and the socket delivers strings. Anything unrecognised (heartbeats,
 * `{ ok: true }` acks) yields nothing rather than throwing — a malformed frame
 * must never kill the connection.
 */
function extractEnvelopes(payload: unknown): RealtimeEnvelope[] {
  let value = payload;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.filter(isEnvelope);
  if (isEnvelope(value)) return [value];
  if (value && typeof value === 'object') {
    const events = (value as { events?: unknown }).events;
    if (Array.isArray(events)) return events.filter(isEnvelope);
  }
  return [];
}

function isEnvelope(value: unknown): value is RealtimeEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RealtimeEnvelope>;
  return typeof candidate.event === 'string' && candidate.data !== undefined;
}

export type { Conversation, Message, RealtimeEnvelope, SessionResponse };
