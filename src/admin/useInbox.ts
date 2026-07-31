/**
 * Data layer for the agent inbox.
 *
 * Deliberately self-contained: it speaks plain `fetch` to the mounted server
 * routes and owns its own long-poll loop. The visitor widget has a similar
 * loop, but the two are NOT shared — the widget is scoped to one conversation
 * and one session token, the inbox is scoped to a whole site and an agent
 * session. Coupling them would mean every widget change risks the staff
 * console, so a little duplication buys a lot of independence.
 *
 * Routes consumed (all relative to `baseUrl`, all carrying `siteId`):
 *   GET  /conversations?siteId&limit&cursor   -> Page<Conversation>
 *   GET  /messages?siteId&conversationId      -> Page<Message>
 *   POST /conversations/{id}/claim?siteId     -> { conversation } | 409
 *   POST /conversations/{id}/close?siteId     -> { conversation }
 *   POST /messages?siteId                     -> { message }
 *   GET  /poll?siteId&after&timeout           -> { events: RealtimeEnvelope[] }
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Agent,
  ApiErrorCode,
  ConnectionState,
  Conversation,
  ConversationStatus,
  Message,
  Page,
  RealtimeEnvelope,
  SiteId,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** Gap between long-poll requests. The server does the waiting, not us. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** How long we ask the server to hold an empty poll open. */
const POLL_HOLD_MS = 25_000;
/** Reconnect backoff ceiling, mirroring `TransportOptions.maxBackoffMs`. */
const MAX_BACKOFF_MS = 30_000;
/** An inbox page. Agents triage the top of the list; they do not scroll 500 rows. */
const LIST_PAGE_SIZE = 50;
/** How long a transient notice ("another agent claimed this") stays up. */
const NOTICE_TTL_MS = 6_000;

/** Tab order is triage order: unclaimed first, resolved last. */
export const INBOX_FILTERS: readonly ConversationStatus[] = ['open', 'assigned', 'ai', 'closed'];

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A non-2xx response. Carries the HTTP status separately from the parsed
 * `ApiError.code` because the claim race is detected by status 409 alone —
 * we must not depend on the body being well-formed to lose a race gracefully.
 */
export class InboxRequestError extends Error {
  readonly status: number;
  readonly code?: ApiErrorCode;

  constructor(message: string, status: number, code?: ApiErrorCode) {
    super(message);
    this.name = 'InboxRequestError';
    this.status = status;
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Time formatting                                                             */
/* -------------------------------------------------------------------------- */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time for dense list rows ("4m", "2h", "3d", "12 Mar").
 *
 * Hand-rolled rather than pulled from a date library: the inbox needs exactly
 * one format, and a dependency here would land in every consumer's bundle.
 */
export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const delta = now - then;
  // Clock skew between server and browser can make "now" look like the future.
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;

  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Full timestamp for `title`/`datetime` attributes and thread separators. */
export function formatAbsoluteTime(iso: string | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  return new Date(then).toLocaleString();
}

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

export interface UseInboxOptions {
  siteId: SiteId;
  /** Base URL of the mounted server routes, e.g. `/api/livechat`. */
  baseUrl: string;
  /** The signed-in agent. Drives "assigned to me" checks and reply authorship. */
  agent: Agent;
  /** Delay between long-poll requests. Default 2000ms. */
  pollIntervalMs?: number;
}

export type StatusCounts = Record<ConversationStatus, number>;

export interface InboxState {
  /** Every conversation loaded so far, newest activity first. */
  conversations: Conversation[];
  /** `conversations` narrowed to the active filter. */
  visible: Conversation[];
  counts: StatusCounts;
  filter: ConversationStatus;
  selectedId: string | null;
  selected: Conversation | null;
  /** Thread for `selectedId`, oldest first. */
  messages: Message[];
  connection: ConnectionState;
  loadingList: boolean;
  loadingThread: boolean;
  sending: boolean;
  hasMore: boolean;
  /** Sticky failure worth surfacing in the shell. */
  error: string | null;
  /** Transient, self-clearing feedback (lost claim race, close confirmed, …). */
  notice: string | null;
}

export interface InboxActions {
  setFilter(status: ConversationStatus): void;
  selectConversation(id: string | null): void;
  /** Resolves `true` when this agent won the claim, `false` when it lost the race. */
  claim(conversationId: string): Promise<boolean>;
  close(conversationId: string): Promise<void>;
  sendReply(body: string): Promise<void>;
  loadMore(): void;
  refresh(): void;
  dismissNotice(): void;
}

export type UseInboxResult = InboxState & InboxActions;

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** Poll payload. Shape-tolerant because the transport may frame it either way. */
interface PollPayload {
  events?: RealtimeEnvelope[];
  envelopes?: RealtimeEnvelope[];
  /** Highest `seq` the server emitted; lets us resume even on an empty batch. */
  cursor?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string })?.name === 'AbortError';
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Newest activity first; `lastMessageAt` falls back to creation for empty chats. */
function activityAt(c: Conversation): number {
  const stamp = c.lastMessageAt ?? c.updatedAt ?? c.createdAt;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function upsertConversation(list: Conversation[], next: Conversation): Conversation[] {
  const idx = list.findIndex((c) => c.id === next.id);
  const current = idx === -1 ? undefined : list[idx];
  if (!current) return [next, ...list];
  const copy = list.slice();
  copy[idx] = { ...current, ...next };
  return copy;
}

function patchConversation(
  list: Conversation[],
  id: string,
  patch: (c: Conversation) => Conversation,
): Conversation[] {
  const idx = list.findIndex((c) => c.id === id);
  const current = idx === -1 ? undefined : list[idx];
  if (!current) return list;
  const copy = list.slice();
  copy[idx] = patch(current);
  return copy;
}

/**
 * Merge one message into a thread, reconciling optimistic sends.
 *
 * A reply we posted ourselves arrives twice: once as the POST response and once
 * as a `message:new` envelope. `clientId` is the join key that keeps the agent
 * from seeing their own reply duplicated.
 */
function mergeMessage(thread: Message[], incoming: Message): Message[] {
  const idx = thread.findIndex(
    (m) => m.id === incoming.id || (!!incoming.clientId && m.clientId === incoming.clientId),
  );
  if (idx !== -1) {
    const copy = thread.slice();
    copy[idx] = incoming;
    return copy;
  }
  const next = [...thread, incoming];
  next.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return next;
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                        */
/* -------------------------------------------------------------------------- */

export function useInbox(options: UseInboxOptions): UseInboxResult {
  const { siteId, baseUrl, agent, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filter, setFilterState] = useState<ConversationStatus>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped by `refresh()` to re-run the list effect. */
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Every in-flight request registers here so unmount can abort the lot. React
   * 18 StrictMode mounts twice in development, so leaked fetches are not
   * hypothetical — they show up as duplicate polls on the very first render.
   */
  const inFlight = useRef<Set<AbortController>>(new Set());
  /** Aborts the previous thread load when the agent clicks a different row. */
  const threadRequest = useRef<AbortController | null>(null);
  /** Long-poll resume cursor; see `RealtimeEnvelope.seq`. */
  const seqRef = useRef(0);
  /** Read inside the poll loop, which must not re-subscribe on every selection. */
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  /** Latest sorted list, so `loadMore` can find the oldest row without a dep cycle. */
  const orderedRef = useRef<Conversation[]>([]);

  const newController = useCallback((): AbortController => {
    const controller = new AbortController();
    inFlight.current.add(controller);
    return controller;
  }, []);

  const releaseController = useCallback((controller: AbortController): void => {
    inFlight.current.delete(controller);
  }, []);

  useEffect(() => {
    const pending = inFlight.current;
    return () => {
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, []);

  const request = useCallback(
    async <T,>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> => {
      const res = await fetch(joinUrl(baseUrl, path), {
        ...init,
        signal,
        // Staff routes are cookie-authenticated; `include` also covers a console
        // hosted on a different origin from the API.
        credentials: 'include',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      });

      if (!res.ok) {
        let code: ApiErrorCode | undefined;
        let detail = `Request failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string; code?: ApiErrorCode };
          if (body?.code) code = body.code;
          if (body?.error) detail = body.error;
        } catch {
          // A proxy or gateway error page is not JSON. The status still tells
          // us everything we need for the 409 path.
        }
        throw new InboxRequestError(detail, res.status, code);
      }

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    [baseUrl],
  );

  const flashNotice = useCallback((text: string): void => {
    setNotice(text);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /* --- conversation list ------------------------------------------------- */

  useEffect(() => {
    const controller = newController();
    let cancelled = false;
    setLoadingList(true);

    const params = new URLSearchParams({ siteId, limit: String(LIST_PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);

    request<Page<Conversation>>(`/conversations?${params.toString()}`, { method: 'GET' }, controller.signal)
      .then((page) => {
        if (cancelled) return;
        setConversations((prev) => {
          // A cursored fetch appends; a fresh fetch replaces, so a refresh
          // cannot resurrect rows the server no longer returns.
          const base = cursor ? prev : [];
          return page.items.reduce(upsertConversation, base);
        });
        setHasMore(page.hasMore);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || isAbort(err)) return;
        setError(messageOf(err, 'Could not load conversations.'));
      })
      .finally(() => {
        releaseController(controller);
        if (!cancelled) setLoadingList(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      releaseController(controller);
    };
  }, [siteId, cursor, reloadToken, request, newController, releaseController]);

  /* --- selected thread --------------------------------------------------- */

  useEffect(() => {
    threadRequest.current?.abort();
    if (!selectedId) {
      setMessages([]);
      setLoadingThread(false);
      return;
    }

    const controller = newController();
    threadRequest.current = controller;
    let cancelled = false;
    setLoadingThread(true);
    setMessages([]);

    const params = new URLSearchParams({ siteId, conversationId: selectedId });
    request<Page<Message>>(`/messages?${params.toString()}`, { method: 'GET' }, controller.signal)
      .then((page) => {
        if (cancelled) return;
        const ordered = page.items.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        setMessages(ordered);
      })
      .catch((err: unknown) => {
        if (cancelled || isAbort(err)) return;
        setError(messageOf(err, 'Could not load this conversation.'));
      })
      .finally(() => {
        releaseController(controller);
        if (!cancelled) setLoadingThread(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      releaseController(controller);
    };
  }, [siteId, selectedId, request, newController, releaseController]);

  /* --- realtime ----------------------------------------------------------- */

  const applyEnvelope = useCallback((env: RealtimeEnvelope): void => {
    if (env.siteId !== siteId) return;
    if (typeof env.seq === 'number' && env.seq > seqRef.current) seqRef.current = env.seq;

    switch (env.event) {
      case 'message:new':
      case 'message:updated': {
        const { message } = env.data;
        if (message.conversationId === selectedIdRef.current) {
          setMessages((prev) => mergeMessage(prev, message));
        }
        // Keep the row's preview live even when the thread is not open. The
        // server's `conversation:updated` is authoritative and overwrites this
        // the moment it lands; this is only here so the list never looks stale.
        setConversations((prev) =>
          patchConversation(prev, message.conversationId, (c) => ({
            ...c,
            lastMessagePreview: message.body.slice(0, 140),
            lastMessageAt: message.createdAt,
            unreadForAgent:
              env.event === 'message:new' &&
              message.senderType === 'visitor' &&
              message.conversationId !== selectedIdRef.current
                ? c.unreadForAgent + 1
                : c.unreadForAgent,
          })),
        );
        break;
      }
      case 'conversation:updated': {
        const { conversation } = env.data;
        setConversations((prev) => upsertConversation(prev, conversation));
        break;
      }
      case 'conversation:assigned': {
        const { conversationId, agent: assignee } = env.data;
        setConversations((prev) =>
          patchConversation(prev, conversationId, (c) => ({
            ...c,
            status: 'assigned',
            assignedAgentId: assignee.id,
          })),
        );
        break;
      }
      case 'conversation:closed': {
        const { conversationId } = env.data;
        setConversations((prev) =>
          patchConversation(prev, conversationId, (c) => ({
            ...c,
            status: 'closed',
            assignedAgentId: undefined,
          })),
        );
        break;
      }
      default:
        // `typing` and `presence` carry no inbox-list state today. Ignoring an
        // unknown event is correct: the server may ship new ones before we do.
        break;
    }
  }, [siteId]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let failures = 0;
    setConnection('connecting');

    void (async () => {
      while (!signal.aborted) {
        const params = new URLSearchParams({
          siteId,
          after: String(seqRef.current),
          timeout: String(POLL_HOLD_MS),
        });
        try {
          const payload = await request<PollPayload>(
            `/poll?${params.toString()}`,
            { method: 'GET' },
            signal,
          );
          if (signal.aborted) return;

          failures = 0;
          setConnection('polling');
          const batch = payload.events ?? payload.envelopes ?? [];
          for (const env of batch) applyEnvelope(env);
          if (typeof payload.cursor === 'number' && payload.cursor > seqRef.current) {
            seqRef.current = payload.cursor;
          }
          await sleep(pollIntervalMs, signal);
        } catch (err: unknown) {
          if (signal.aborted || isAbort(err)) return;
          failures += 1;
          setConnection('connecting');
          // Exponential backoff with a ceiling: a server restart should not turn
          // an idle inbox into a request flood.
          const backoff = Math.min(pollIntervalMs * 2 ** failures, MAX_BACKOFF_MS);
          await sleep(backoff, signal);
        }
      }
    })();

    return () => {
      controller.abort();
      setConnection('closed');
    };
  }, [siteId, pollIntervalMs, request, applyEnvelope]);

  /* --- actions ------------------------------------------------------------ */

  const setFilter = useCallback((status: ConversationStatus): void => {
    setFilterState(status);
  }, []);

  const selectConversation = useCallback(
    (id: string | null): void => {
      setSelectedId(id);
      if (!id) return;

      // Opening the thread is the read receipt. Clear the badge locally for an
      // instant response, then tell the server so it survives a refresh and
      // reaches the agent's other tabs. A failed receipt is not worth
      // surfacing — the badge simply reappears on the next load.
      setConversations((prev) => patchConversation(prev, id, (c) => ({ ...c, unreadForAgent: 0 })));

      const params = new URLSearchParams({ siteId });
      const controller = newController();
      void request(
        `/conversations/${encodeURIComponent(id)}/read?${params.toString()}`,
        { method: 'POST' },
        controller.signal,
      )
        .catch(() => undefined)
        .finally(() => releaseController(controller));
    },
    [siteId, request, newController, releaseController],
  );

  const refresh = useCallback((): void => {
    setCursor(undefined);
    setReloadToken((n) => n + 1);
  }, []);

  const loadMore = useCallback((): void => {
    const list = orderedRef.current;
    // The server paginates by opaque cursor; the id of the oldest row we hold
    // is the only cursor we can synthesise without an extra round trip.
    const oldest = list.length > 0 ? list[list.length - 1] : undefined;
    if (oldest) setCursor(oldest.id);
  }, []);

  const claim = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const controller = newController();
      try {
        const params = new URLSearchParams({ siteId });
        const result = await request<{ conversation: Conversation }>(
          `/conversations/${encodeURIComponent(conversationId)}/claim?${params.toString()}`,
          { method: 'POST' },
          controller.signal,
        );
        setConversations((prev) => upsertConversation(prev, result.conversation));
        return true;
      } catch (err: unknown) {
        if (isAbort(err)) return false;
        // Claiming is atomic server-side, so losing is a normal outcome, not a
        // failure: another agent got there first. Surface it and resync rather
        // than throwing into the component tree.
        if (err instanceof InboxRequestError && (err.status === 409 || err.code === 'conflict')) {
          flashNotice('Another agent claimed this conversation.');
          refresh();
          return false;
        }
        setError(messageOf(err, 'Could not claim this conversation.'));
        return false;
      } finally {
        releaseController(controller);
      }
    },
    [siteId, request, newController, releaseController, flashNotice, refresh],
  );

  const close = useCallback(
    async (conversationId: string): Promise<void> => {
      const controller = newController();
      try {
        const params = new URLSearchParams({ siteId });
        const result = await request<{ conversation: Conversation }>(
          `/conversations/${encodeURIComponent(conversationId)}/close?${params.toString()}`,
          { method: 'POST' },
          controller.signal,
        );
        setConversations((prev) => upsertConversation(prev, result.conversation));
        flashNotice('Conversation closed.');
      } catch (err: unknown) {
        if (isAbort(err)) return;
        setError(messageOf(err, 'Could not close this conversation.'));
      } finally {
        releaseController(controller);
      }
    },
    [siteId, request, newController, releaseController, flashNotice],
  );

  const sendReply = useCallback(
    async (body: string): Promise<void> => {
      const conversationId = selectedIdRef.current;
      const text = body.trim();
      if (!conversationId || text.length === 0) return;

      const clientId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: Message = {
        siteId,
        id: clientId,
        conversationId,
        senderType: 'agent',
        senderId: agent.id,
        senderName: agent.name,
        body: text,
        clientId,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => mergeMessage(prev, optimistic));
      setSending(true);

      const controller = newController();
      try {
        const params = new URLSearchParams({ siteId });
        const result = await request<{ message: Message }>(
          `/messages?${params.toString()}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId, body: text, clientId }),
          },
          controller.signal,
        );
        if (result?.message) setMessages((prev) => mergeMessage(prev, result.message));
        setConversations((prev) =>
          patchConversation(prev, conversationId, (c) => ({
            ...c,
            lastMessagePreview: text.slice(0, 140),
            lastMessageAt: optimistic.createdAt,
          })),
        );
      } catch (err: unknown) {
        if (isAbort(err)) return;
        // Roll the bubble back so the agent knows the reply did not land.
        setMessages((prev) => prev.filter((m) => m.clientId !== clientId));
        setError(messageOf(err, 'Message not sent.'));
      } finally {
        releaseController(controller);
        setSending(false);
      }
    },
    [siteId, agent.id, agent.name, request, newController, releaseController],
  );

  const dismissNotice = useCallback((): void => setNotice(null), []);

  /* --- derived ------------------------------------------------------------ */

  const ordered = useMemo(
    () => conversations.slice().sort((a, b) => activityAt(b) - activityAt(a)),
    [conversations],
  );
  orderedRef.current = ordered;

  const counts = useMemo<StatusCounts>(() => {
    const base: StatusCounts = { open: 0, assigned: 0, ai: 0, closed: 0 };
    for (const c of conversations) base[c.status] += 1;
    return base;
  }, [conversations]);

  const visible = useMemo(() => ordered.filter((c) => c.status === filter), [ordered, filter]);

  const selected = useMemo(
    () => ordered.find((c) => c.id === selectedId) ?? null,
    [ordered, selectedId],
  );

  return {
    conversations: ordered,
    visible,
    counts,
    filter,
    selectedId,
    selected,
    messages,
    connection,
    loadingList,
    loadingThread,
    sending,
    hasMore,
    error,
    notice,
    setFilter,
    selectConversation,
    claim,
    close,
    sendReply,
    loadMore,
    refresh,
    dismissNotice,
  };
}
