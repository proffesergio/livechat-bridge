/**
 * The inbox left rail: status tabs plus one row per conversation.
 *
 * Presentational on purpose — it holds no fetch state, only the keyboard
 * cursor. `AgentInbox` owns the data (via `useInbox`) so this component can be
 * dropped into a host app's own shell.
 *
 * Keyboard model: the list is a single tab stop (`role="listbox"`) with a
 * roving cursor driven by `aria-activedescendant`. Arrows move the cursor
 * without loading a thread; Enter/Space opens. That split matters for agents
 * triaging by keyboard — scanning must not mark ten conversations as read.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Conversation, ConversationStatus } from '../types.js';
import { INBOX_FILTERS, formatAbsoluteTime, formatRelativeTime, type StatusCounts } from './useInbox.js';

export interface ConversationListProps {
  conversations: Conversation[];
  counts: StatusCounts;
  filter: ConversationStatus;
  selectedId: string | null;
  loading?: boolean;
  hasMore?: boolean;
  onFilterChange(status: ConversationStatus): void;
  onSelect(id: string): void;
  onLoadMore?(): void;
  /** Rendered inside the list body when a request failed. */
  error?: string | null;
}

const FILTER_LABELS: Record<ConversationStatus, string> = {
  open: 'Unclaimed',
  assigned: 'Assigned',
  ai: 'AI',
  closed: 'Closed',
};

const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  ai: 'AI handled',
  closed: 'Closed',
};

/**
 * Empty states are per-filter because "nothing here" means something different
 * in each tab — an empty `open` tab is good news, an empty `closed` tab is not.
 */
const EMPTY_STATES: Record<ConversationStatus, { title: string; hint: string }> = {
  open: { title: 'Inbox zero', hint: 'No unclaimed conversations. New chats land here first.' },
  assigned: { title: 'Nothing assigned', hint: 'Conversations you or a teammate claim appear here.' },
  ai: { title: 'No AI conversations', hint: 'The assistant answers when nobody claims a chat in time.' },
  closed: { title: 'No closed conversations', hint: 'Resolved conversations are archived here.' },
};

/** Anonymous visitors are the common case, not an edge case — name them clearly. */
export function visitorLabel(conversation: Conversation): string {
  const name = conversation.visitorName?.trim();
  if (name) return name;
  const email = conversation.visitorEmail?.trim();
  if (email) return email;
  return 'Anonymous visitor';
}

/** Two-letter monogram for the row avatar. Purely decorative, hence aria-hidden. */
export function initialsOf(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => (p[0] ?? '').toUpperCase()).join('');
}

export function ConversationList(props: ConversationListProps): JSX.Element {
  const {
    conversations,
    counts,
    filter,
    selectedId,
    loading = false,
    hasMore = false,
    onFilterChange,
    onSelect,
    onLoadMore,
    error = null,
  } = props;

  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Anchor the cursor to the open conversation when the tab or the selection
  // changes. Deliberately NOT keyed on `conversations`: a background poll must
  // not yank the cursor back while an agent is arrowing through the list.
  useEffect(() => {
    setCursor((prev) => {
      const index = conversations.findIndex((c) => c.id === selectedId);
      return index === -1 ? (selectedId === null ? prev : 0) : index;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [filter, selectedId]);

  // Rows can disappear (status change, refresh), so keep the cursor in range.
  useEffect(() => {
    setCursor((prev) => Math.min(prev, Math.max(conversations.length - 1, 0)));
  }, [conversations.length]);

  const rowDomId = useCallback(
    (conversationId: string) => `${listId}-row-${conversationId}`,
    [listId],
  );

  const activeDescendant = useMemo(() => {
    const active = conversations[cursor];
    return active ? rowDomId(active.id) : undefined;
  }, [conversations, cursor, rowDomId]);

  // Keep the cursor row on screen when it moves by keyboard. `useId` values
  // contain colons, so the selector must be escaped.
  useEffect(() => {
    if (!activeDescendant) return;
    const node = listRef.current?.querySelector(`#${CSS.escape(activeDescendant)}`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' });
  }, [activeDescendant]);

  const onListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (conversations.length === 0) return;
      const last = conversations.length - 1;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setCursor((i) => Math.min(i + 1, last));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setCursor((i) => Math.max(i - 1, 0));
          break;
        case 'Home':
          event.preventDefault();
          setCursor(0);
          break;
        case 'End':
          event.preventDefault();
          setCursor(last);
          break;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const target = conversations[cursor];
          if (target) onSelect(target.id);
          break;
        }
        default:
          break;
      }
    },
    [conversations, cursor, onSelect],
  );

  // Tabs use the standard roving-tabindex pattern, so Left/Right must move
  // focus between them — otherwise the inactive tabs are keyboard-unreachable.
  const onTabsKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const current = INBOX_FILTERS.indexOf(filter);
      const nextIndex = (current + delta + INBOX_FILTERS.length) % INBOX_FILTERS.length;
      const next = INBOX_FILTERS[nextIndex];
      if (!next) return;
      onFilterChange(next);
      const node = event.currentTarget.querySelector(`#${CSS.escape(`${listId}-tab-${next}`)}`);
      if (node instanceof HTMLElement) node.focus();
    },
    [filter, listId, onFilterChange],
  );

  const empty = EMPTY_STATES[filter];
  const now = Date.now();

  return (
    <div className="lcb-admin-list">
      <div
        className="lcb-admin-list__tabs"
        role="tablist"
        aria-label="Filter conversations"
        onKeyDown={onTabsKeyDown}
      >
        {INBOX_FILTERS.map((status) => {
          const active = status === filter;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              id={`${listId}-tab-${status}`}
              aria-selected={active}
              aria-controls={`${listId}-panel`}
              tabIndex={active ? 0 : -1}
              className="lcb-admin-tab"
              data-active={active || undefined}
              onClick={() => onFilterChange(status)}
            >
              <span className="lcb-admin-tab__label">{FILTER_LABELS[status]}</span>
              <span className="lcb-admin-tab__count" aria-label={`${counts[status]} conversations`}>
                {counts[status]}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={`${listId}-panel`}
        role="tabpanel"
        aria-labelledby={`${listId}-tab-${filter}`}
        className="lcb-admin-list__panel"
      >
        {error ? (
          <p className="lcb-admin-list__error" role="status">
            {error}
          </p>
        ) : null}

        {conversations.length === 0 ? (
          <div className="lcb-admin-empty">
            {loading ? (
              <p className="lcb-admin-empty__title">Loading…</p>
            ) : (
              <>
                <p className="lcb-admin-empty__title">{empty.title}</p>
                <p className="lcb-admin-empty__hint">{empty.hint}</p>
              </>
            )}
          </div>
        ) : (
          <div
            ref={listRef}
            className="lcb-admin-rows"
            role="listbox"
            tabIndex={0}
            aria-label={`${FILTER_LABELS[filter]} conversations`}
            aria-activedescendant={activeDescendant}
            onKeyDown={onListKeyDown}
          >
            {conversations.map((conversation, index) => {
              const label = visitorLabel(conversation);
              const isSelected = conversation.id === selectedId;
              const stamp = conversation.lastMessageAt ?? conversation.createdAt;
              return (
                <div
                  key={conversation.id}
                  id={rowDomId(conversation.id)}
                  role="option"
                  aria-selected={isSelected}
                  className="lcb-admin-row"
                  data-selected={isSelected || undefined}
                  data-cursor={index === cursor || undefined}
                  data-unread={conversation.unreadForAgent > 0 || undefined}
                  onClick={() => {
                    setCursor(index);
                    onSelect(conversation.id);
                  }}
                >
                  <span className="lcb-admin-row__avatar" aria-hidden="true">
                    {initialsOf(label)}
                  </span>

                  <span className="lcb-admin-row__body">
                    <span className="lcb-admin-row__top">
                      <span className="lcb-admin-row__name">{label}</span>
                      <time
                        className="lcb-admin-row__time"
                        dateTime={stamp}
                        title={formatAbsoluteTime(stamp)}
                      >
                        {formatRelativeTime(stamp, now)}
                      </time>
                    </span>

                    <span className="lcb-admin-row__preview">
                      {conversation.lastMessagePreview || 'No messages yet'}
                    </span>

                    <span className="lcb-admin-row__meta">
                      <span className="lcb-admin-pill" data-status={conversation.status}>
                        {STATUS_LABELS[conversation.status]}
                      </span>
                      {conversation.unreadForAgent > 0 ? (
                        <span
                          className="lcb-admin-badge"
                          aria-label={`${conversation.unreadForAgent} unread messages`}
                        >
                          {conversation.unreadForAgent > 99 ? '99+' : conversation.unreadForAgent}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Outside the listbox: a `role="listbox"` may only own `option` children. */}
        {hasMore && onLoadMore ? (
          <button type="button" className="lcb-admin-more" onClick={onLoadMore}>
            Load older conversations
          </button>
        ) : null}
      </div>
    </div>
  );
}

export { STATUS_LABELS, FILTER_LABELS };
