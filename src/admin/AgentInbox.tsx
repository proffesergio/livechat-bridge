/**
 * The staff console: conversation list, thread, and visitor detail.
 *
 * One component owns the whole screen because the three panes share a single
 * selection and a single realtime stream — splitting the state across them
 * would mean lifting it back up on the first feature request anyway.
 *
 * Consumers must also load `livechat-bridge/admin/admin.css`; the styles are
 * shipped as a plain stylesheet so hosts can override the `--lcb-admin-*`
 * custom properties from their own theme without a CSS-in-JS runtime.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Agent, ConnectionState, Conversation, Message, SiteId } from '../types.js';
import { ConversationList, STATUS_LABELS, initialsOf, visitorLabel } from './ConversationList.js';
import { formatAbsoluteTime, formatRelativeTime, useInbox } from './useInbox.js';

export interface AgentInboxProps {
  siteId: SiteId;
  /** Base URL of the mounted server routes, e.g. `/api/livechat`. */
  baseUrl: string;
  /** The signed-in agent. Reply authorship and claim ownership derive from this. */
  agent: Agent;
  /** Delay between long-poll requests. Default 2000ms. */
  pollIntervalMs?: number;
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: 'Idle',
  connecting: 'Reconnecting',
  // `polling` is the healthy fallback state, so it must not read as degraded.
  open: 'Live',
  polling: 'Live',
  closed: 'Disconnected',
};

/* -------------------------------------------------------------------------- */
/* Composer gating                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why the composer is locked, or `null` when the agent may reply.
 *
 * Returning the reason rather than a boolean is deliberate: a disabled input
 * with no explanation is the single most common complaint about shared inboxes.
 */
function replyBlockedReason(conversation: Conversation | null, agent: Agent): string | null {
  if (!conversation) return 'Select a conversation to reply.';
  if (conversation.status === 'closed') return 'This conversation is closed. Reopen it from the visitor side.';
  if (!conversation.assignedAgentId) {
    return conversation.status === 'ai'
      ? 'The assistant is handling this. Claim it to take over.'
      : 'Claim this conversation to reply.';
  }
  if (conversation.assignedAgentId !== agent.id) return 'Assigned to another agent.';
  return null;
}

/** Claiming only makes sense while nobody owns the conversation. */
function isClaimable(conversation: Conversation | null): boolean {
  if (!conversation) return false;
  if (conversation.status === 'closed') return false;
  return !conversation.assignedAgentId;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function AgentInbox(props: AgentInboxProps): JSX.Element {
  const { siteId, baseUrl, agent, pollIntervalMs } = props;

  const inbox = useInbox({
    siteId,
    baseUrl,
    agent,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });

  const {
    visible,
    conversations,
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
  } = inbox;

  const [draft, setDraft] = useState('');
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const cancelCloseRef = useRef<HTMLButtonElement | null>(null);
  const composerId = useId();

  const blockedReason = replyBlockedReason(selected, agent);
  const canReply = blockedReason === null;

  // Reset per-conversation UI when the selection moves; a half-typed reply must
  // never follow the agent into someone else's thread.
  useEffect(() => {
    setDraft('');
    setConfirmingClose(false);
  }, [selectedId]);

  // Move focus into the confirmation, landing on Cancel — closing is
  // destructive, so the safe option is the one under the agent's fingers.
  useEffect(() => {
    if (confirmingClose) cancelCloseRef.current?.focus();
  }, [confirmingClose]);

  // Pin the transcript to the newest message. `aria-live` announces the arrival
  // for screen readers; this keeps sighted agents in the same place.
  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const onClaim = useCallback(async (): Promise<void> => {
    if (!selected) return;
    setClaiming(true);
    // A lost race is reported through `notice`, not thrown — see `useInbox`.
    await claim(selected.id);
    setClaiming(false);
  }, [claim, selected]);

  const onSend = useCallback((): void => {
    if (!canReply || draft.trim().length === 0) return;
    const body = draft;
    setDraft('');
    void sendReply(body);
  }, [canReply, draft, sendReply]);

  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      // Enter sends, Shift+Enter breaks the line — the convention every agent
      // already has in their fingers from Slack and every other console.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSend();
      }
    },
    [onSend],
  );

  /** Every other conversation from the same visitor, newest first. */
  const history = useMemo(() => {
    if (!selected) return [] as Conversation[];
    return conversations.filter((c) => c.visitorId === selected.visitorId && c.id !== selected.id);
  }, [conversations, selected]);

  const metadataEntries = useMemo(() => {
    const meta = selected?.metadata;
    if (!meta) return [] as Array<[string, string]>;
    return Object.entries(meta).map<[string, string]>(([key, value]) => [key, stringifyMeta(value)]);
  }, [selected]);

  return (
    <div className="lcb-admin" data-pane={selectedId ? 'thread' : 'list'}>
      <header className="lcb-admin-topbar">
        <div className="lcb-admin-topbar__brand">
          <span className="lcb-admin-topbar__title">Inbox</span>
          <span className="lcb-admin-topbar__site" title={`Site ${siteId}`}>
            {siteId}
          </span>
        </div>

        <div className="lcb-admin-topbar__right">
          <span className="lcb-admin-conn" data-state={connection}>
            <span className="lcb-admin-conn__dot" aria-hidden="true" />
            <span className="lcb-admin-conn__label" role="status">
              {CONNECTION_LABELS[connection]}
            </span>
          </span>
          <span className="lcb-admin-me">
            <span className="lcb-admin-me__avatar" aria-hidden="true">
              {initialsOf(agent.name)}
            </span>
            <span className="lcb-admin-me__name">{agent.name}</span>
          </span>
        </div>
      </header>

      {notice ? (
        <p className="lcb-admin-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="lcb-admin-panes">
        <nav className="lcb-admin-pane lcb-admin-pane--list" aria-label="Conversations">
          <ConversationList
            conversations={visible}
            counts={counts}
            filter={filter}
            selectedId={selectedId}
            loading={loadingList}
            hasMore={hasMore}
            error={error}
            onFilterChange={setFilter}
            onSelect={selectConversation}
            onLoadMore={loadMore}
          />
        </nav>

        <main className="lcb-admin-pane lcb-admin-pane--thread" aria-label="Conversation">
          {!selected ? (
            <div className="lcb-admin-empty lcb-admin-empty--thread">
              <p className="lcb-admin-empty__title">No conversation selected</p>
              <p className="lcb-admin-empty__hint">
                Pick a conversation on the left, or move through the list with the arrow keys and
                press Enter.
              </p>
            </div>
          ) : (
            <>
              <div className="lcb-admin-thread__header">
                <button
                  type="button"
                  className="lcb-admin-back"
                  onClick={() => selectConversation(null)}
                  aria-label="Back to conversation list"
                >
                  ←
                </button>

                <div className="lcb-admin-thread__ident">
                  <h2 className="lcb-admin-thread__name">{visitorLabel(selected)}</h2>
                  <p className="lcb-admin-thread__sub">
                    <span className="lcb-admin-pill" data-status={selected.status}>
                      {STATUS_LABELS[selected.status]}
                    </span>
                    <span
                      className="lcb-admin-thread__started"
                      title={formatAbsoluteTime(selected.createdAt)}
                    >
                      Started {formatRelativeTime(selected.createdAt)}
                    </span>
                  </p>
                </div>

                <div className="lcb-admin-thread__actions">
                  {isClaimable(selected) ? (
                    <button
                      type="button"
                      className="lcb-admin-btn lcb-admin-btn--primary"
                      onClick={() => void onClaim()}
                      disabled={claiming}
                    >
                      {claiming ? 'Claiming…' : 'Claim'}
                    </button>
                  ) : null}

                  {selected.status !== 'closed' ? (
                    <button
                      type="button"
                      className="lcb-admin-btn"
                      onClick={() => setConfirmingClose(true)}
                    >
                      Close
                    </button>
                  ) : null}
                </div>
              </div>

              {confirmingClose ? (
                <div
                  className="lcb-admin-confirm"
                  role="group"
                  aria-label="Confirm closing this conversation"
                >
                  <p className="lcb-admin-confirm__text">
                    Close this conversation? The visitor will see a transcript and can start a new
                    chat.
                  </p>
                  <div className="lcb-admin-confirm__actions">
                    <button
                      type="button"
                      ref={cancelCloseRef}
                      className="lcb-admin-btn"
                      onClick={() => setConfirmingClose(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="lcb-admin-btn lcb-admin-btn--danger"
                      onClick={() => {
                        setConfirmingClose(false);
                        void close(selected.id);
                      }}
                    >
                      Close conversation
                    </button>
                  </div>
                </div>
              ) : null}

              <div
                ref={threadRef}
                className="lcb-admin-thread"
                aria-live="polite"
                aria-busy={loadingThread}
                aria-label="Messages"
              >
                {loadingThread && messages.length === 0 ? (
                  <p className="lcb-admin-thread__status">Loading messages…</p>
                ) : null}

                {!loadingThread && messages.length === 0 ? (
                  <p className="lcb-admin-thread__status">No messages in this conversation yet.</p>
                ) : null}

                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} agentId={agent.id} />
                ))}
              </div>

              <form
                className="lcb-admin-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSend();
                }}
              >
                <label className="lcb-admin-sr-only" htmlFor={`${composerId}-reply`}>
                  Reply to {visitorLabel(selected)}
                </label>
                <textarea
                  id={`${composerId}-reply`}
                  className="lcb-admin-composer__input"
                  value={draft}
                  rows={3}
                  disabled={!canReply}
                  placeholder={canReply ? 'Write a reply… (Enter to send, Shift+Enter for a new line)' : ''}
                  aria-describedby={canReply ? undefined : `${composerId}-blocked`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                />

                <div className="lcb-admin-composer__footer">
                  {canReply ? (
                    <span className="lcb-admin-composer__hint">
                      Replying as {agent.name}
                    </span>
                  ) : (
                    <span id={`${composerId}-blocked`} className="lcb-admin-composer__blocked">
                      {blockedReason}
                    </span>
                  )}
                  <button
                    type="submit"
                    className="lcb-admin-btn lcb-admin-btn--primary"
                    disabled={!canReply || sending || draft.trim().length === 0}
                  >
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            </>
          )}
        </main>

        <aside className="lcb-admin-pane lcb-admin-pane--detail" aria-label="Visitor details">
          {!selected ? (
            <p className="lcb-admin-detail__placeholder">Visitor details appear here.</p>
          ) : (
            <div className="lcb-admin-detail">
              <section className="lcb-admin-detail__section" aria-labelledby={`${composerId}-ident`}>
                <h3 id={`${composerId}-ident`} className="lcb-admin-detail__heading">
                  Visitor
                </h3>
                <div className="lcb-admin-detail__ident">
                  <span className="lcb-admin-detail__avatar" aria-hidden="true">
                    {initialsOf(visitorLabel(selected))}
                  </span>
                  <div>
                    <p className="lcb-admin-detail__name">{visitorLabel(selected)}</p>
                    {selected.visitorEmail ? (
                      <p className="lcb-admin-detail__email">{selected.visitorEmail}</p>
                    ) : (
                      <p className="lcb-admin-detail__email lcb-admin-detail__email--none">
                        No email on file
                      </p>
                    )}
                  </div>
                </div>
                <dl className="lcb-admin-facts">
                  <Fact label="Visitor ID" value={selected.visitorId} mono />
                  <Fact label="Status" value={STATUS_LABELS[selected.status]} />
                  <Fact
                    label="Assigned to"
                    value={
                      selected.assignedAgentId
                        ? selected.assignedAgentId === agent.id
                          ? `${agent.name} (you)`
                          : selected.assignedAgentId
                        : 'Unassigned'
                    }
                  />
                  <Fact label="Started" value={formatAbsoluteTime(selected.createdAt)} />
                  <Fact label="Last activity" value={formatAbsoluteTime(selected.lastMessageAt ?? selected.updatedAt)} />
                </dl>
              </section>

              <section className="lcb-admin-detail__section" aria-labelledby={`${composerId}-meta`}>
                <h3 id={`${composerId}-meta`} className="lcb-admin-detail__heading">
                  Context
                </h3>
                {metadataEntries.length === 0 ? (
                  <p className="lcb-admin-detail__muted">The host site attached no metadata.</p>
                ) : (
                  <dl className="lcb-admin-facts">
                    {metadataEntries.map(([key, value]) => (
                      <Fact key={key} label={key} value={value} mono />
                    ))}
                  </dl>
                )}
              </section>

              <section className="lcb-admin-detail__section" aria-labelledby={`${composerId}-history`}>
                <h3 id={`${composerId}-history`} className="lcb-admin-detail__heading">
                  History
                </h3>
                {history.length === 0 ? (
                  <p className="lcb-admin-detail__muted">First conversation from this visitor.</p>
                ) : (
                  <ul className="lcb-admin-history">
                    {history.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="lcb-admin-history__item"
                          onClick={() => selectConversation(c.id)}
                        >
                          <span className="lcb-admin-history__top">
                            <span className="lcb-admin-pill" data-status={c.status}>
                              {STATUS_LABELS[c.status]}
                            </span>
                            <span className="lcb-admin-history__time">
                              {formatRelativeTime(c.lastMessageAt ?? c.createdAt)}
                            </span>
                          </span>
                          <span className="lcb-admin-history__preview">
                            {c.subject || c.lastMessagePreview || 'No messages'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

interface MessageBubbleProps {
  message: Message;
  agentId: string;
}

function MessageBubble({ message, agentId }: MessageBubbleProps): JSX.Element {
  // System notes are transcript furniture, not conversation — they get a
  // centred, unstyled row so they never compete with what people said.
  if (message.senderType === 'system') {
    return (
      <p className="lcb-admin-system">
        <span>{message.body}</span>
      </p>
    );
  }

  const mine = message.senderType === 'agent' && message.senderId === agentId;
  const author =
    message.senderName ??
    (message.senderType === 'ai' ? 'Assistant' : message.senderType === 'agent' ? 'Agent' : 'Visitor');

  return (
    <article className="lcb-admin-msg" data-sender={message.senderType} data-mine={mine || undefined}>
      <header className="lcb-admin-msg__head">
        <span className="lcb-admin-msg__author">{mine ? 'You' : author}</span>
        <time
          className="lcb-admin-msg__time"
          dateTime={message.createdAt}
          title={formatAbsoluteTime(message.createdAt)}
        >
          {formatRelativeTime(message.createdAt)}
        </time>
      </header>
      <div className="lcb-admin-msg__body">{message.body}</div>
      {message.attachments && message.attachments.length > 0 ? (
        <ul className="lcb-admin-msg__files">
          {message.attachments.map((file) => (
            <li key={file.id}>
              <a href={file.url} target="_blank" rel="noreferrer noopener">
                {file.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

interface FactProps {
  label: string;
  value: string;
  mono?: boolean;
}

function Fact({ label, value, mono = false }: FactProps): JSX.Element {
  return (
    <div className="lcb-admin-fact">
      <dt className="lcb-admin-fact__label">{label}</dt>
      <dd className="lcb-admin-fact__value" data-mono={mono || undefined} title={value}>
        {value || '—'}
      </dd>
    </div>
  );
}

/** Host metadata is `unknown`; render it without ever throwing on a cycle. */
function stringifyMeta(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}
