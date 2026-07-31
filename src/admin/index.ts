/**
 * Public surface of `livechat-bridge/admin` — the staff-facing agent console.
 *
 * Drop `AgentInbox` in for the whole screen, or take `useInbox` and compose
 * your own shell around it. Both are exported because "we already have a
 * dashboard layout" is the first thing every host says.
 *
 * The stylesheet is not imported here: bundlers disagree about CSS side-effect
 * imports inside a library entry point, so hosts import
 * `livechat-bridge/admin/admin.css` themselves.
 */

export { AgentInbox } from './AgentInbox.js';
export type { AgentInboxProps } from './AgentInbox.js';

export { ConversationList, visitorLabel, initialsOf } from './ConversationList.js';
export type { ConversationListProps } from './ConversationList.js';

export {
  useInbox,
  InboxRequestError,
  INBOX_FILTERS,
  formatRelativeTime,
  formatAbsoluteTime,
} from './useInbox.js';
export type {
  UseInboxOptions,
  UseInboxResult,
  InboxState,
  InboxActions,
  StatusCounts,
} from './useInbox.js';
