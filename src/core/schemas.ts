import { z } from 'zod';
import { CHAT_STATUS, MAX_MESSAGE_LENGTH, SENDER_TYPE } from './constants.js';

export const chatStatusSchema = z.enum([
  CHAT_STATUS.OPEN,
  CHAT_STATUS.CLAIMED,
  CHAT_STATUS.AI,
  CHAT_STATUS.CLOSED,
]);
export type ChatStatus = z.infer<typeof chatStatusSchema>;

export const senderTypeSchema = z.enum([
  SENDER_TYPE.USER,
  SENDER_TYPE.STAFF,
  SENDER_TYPE.AI,
  SENDER_TYPE.SYSTEM,
]);
export type SenderType = z.infer<typeof senderTypeSchema>;

export const userRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
});
export type UserRef = z.infer<typeof userRefSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  senderType: senderTypeSchema,
  senderId: z.string().min(1).optional(),
  senderName: z.string().min(1).optional(),
  body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  createdAt: z.coerce.date(),
  meta: z.record(z.unknown()).optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const chatSchema = z.object({
  id: z.string().min(1),
  user: userRefSchema,
  status: chatStatusSchema,
  assignedStaffId: z.string().min(1).optional(),
  lastMessageAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  aiTakeoverAt: z.coerce.date().optional(),
  closedAt: z.coerce.date().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type Chat = z.infer<typeof chatSchema>;

/** Payloads accepted by handlers. */

export const sendMessageInputSchema = z.object({
  chatId: z.string().min(1).optional(),
  body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const claimChatInputSchema = z.object({
  chatId: z.string().min(1),
});
export type ClaimChatInput = z.infer<typeof claimChatInputSchema>;

export const closeChatInputSchema = z.object({
  chatId: z.string().min(1),
});
export type CloseChatInput = z.infer<typeof closeChatInputSchema>;

export const listChatsQuerySchema = z.object({
  status: chatStatusSchema.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListChatsQuery = z.infer<typeof listChatsQuerySchema>;

export const pusherAuthInputSchema = z.object({
  socket_id: z.string().min(1),
  channel_name: z.string().min(1),
});
export type PusherAuthInput = z.infer<typeof pusherAuthInputSchema>;
