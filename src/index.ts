/**
 * Root entry for `livechat-bridge`.
 *
 * Deliberately types-only. The three runtime surfaces live behind their own
 * subpath exports so that importing shared types never drags React into a
 * server bundle or Mongoose into a browser bundle:
 *
 *   import { ChatWidget }         from 'livechat-bridge/widget';
 *   import { createRouteHandlers } from 'livechat-bridge/server';
 *   import { AgentInbox }         from 'livechat-bridge/admin';
 */
export type * from './types.js';
