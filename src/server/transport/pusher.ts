import type Pusher from 'pusher';
import { STAFF_CHANNEL, chatChannel } from '../../core/index.js';
import type { Transport, AuthorizedUser, AuthResponse } from './types.js';

/**
 * Thin wrapper around the Pusher server SDK. The rest of the package only sees
 * the `Transport` interface, which makes it trivial to swap Pusher for a
 * self-hosted, Pusher-protocol-compatible server (Sockudo/Soketi) or for SSE.
 */
export class PusherTransport implements Transport {
  constructor(private readonly pusher: Pusher) {}

  async trigger(channel: string, event: string, payload: unknown): Promise<void> {
    await this.pusher.trigger(channel, event, payload);
  }

  authorizeChannel(socketId: string, channel: string, user?: AuthorizedUser): AuthResponse {
    if (channel.startsWith('presence-')) {
      if (!user) throw new Error('Presence channels require an authenticated user');
      return this.pusher.authorizeChannel(socketId, channel, {
        user_id: user.id,
        user_info: { name: user.name, isStaff: user.isStaff },
      }) as unknown as AuthResponse;
    }
    return this.pusher.authorizeChannel(socketId, channel) as unknown as AuthResponse;
  }
}

export { STAFF_CHANNEL, chatChannel };
