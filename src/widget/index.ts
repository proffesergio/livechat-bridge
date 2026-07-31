/**
 * Public surface of `livechat-bridge/widget` — everything a host page needs to
 * embed the visitor chat.
 *
 * The three layers are exported separately on purpose: drop in `ChatWidget` for
 * the batteries-included UI, reach for `useChatSocket` to build your own UI on
 * our connection lifecycle, or take `ChatTransport` alone if you are not using
 * React at all. Only the last one is guaranteed React-free.
 *
 * The stylesheet ships beside this module (`dist/widget/widget.css`) and must
 * be imported by the host: `import 'livechat-bridge/widget/widget.css'`.
 */

export { ChatWidget } from './ChatWidget.js';
export type { ChatWidgetProps } from './ChatWidget.js';

export { useChatSocket } from './useChatSocket.js';
export type {
  OptimisticMessage,
  UseChatSocketOptions,
  UseChatSocketResult,
} from './useChatSocket.js';

export { ChatTransport, createSession } from './transport.js';
export type {
  ChatTransportOptions,
  ClientFrame,
  EnvelopeListener,
  FetchLike,
  HttpResponseLike,
  RequestInitLike,
  WebSocketFactory,
  WebSocketLike,
} from './transport.js';

// Re-exported so consumers can type their own handlers without a second import.
export type {
  Attachment,
  ConnectionState,
  Conversation,
  ConversationStatus,
  Message,
  RealtimeEnvelope,
  SenderType,
  ServerEventMap,
  ServerEventName,
  SessionResponse,
  Visitor,
} from '../types.js';
