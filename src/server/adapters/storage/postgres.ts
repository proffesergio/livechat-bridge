import type { StorageAdapter } from './types.js';

/**
 * Postgres adapter — STUB.
 *
 * Left intentionally unimplemented in v0.1.0 so the package's footprint stays
 * small and Postgres users can wire up their own driver (pg, drizzle, kysely,
 * prisma) without livechat-bridge dictating the choice.
 *
 * To implement, satisfy the `StorageAdapter` interface — see
 * `./types.ts` for the contract, and `./mongo.ts` for a worked example. The
 * trickiest method is `claimChat`, which must be a single atomic UPDATE
 * (`UPDATE chats SET assigned_staff_id = $1 WHERE id = $2 AND (assigned_staff_id IS NULL OR assigned_staff_id = $1) RETURNING *`).
 */
export class PostgresStorage implements StorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: { connectionString: string; tablePrefix?: string }) {
    throw new Error(
      'PostgresStorage is not yet implemented. Use MongoStorage or implement the StorageAdapter interface directly. See src/server/adapters/storage/postgres.ts for guidance.'
    );
  }

  findActiveChatByUser(): never {
    throw new Error('not implemented');
  }
  createChat(): never {
    throw new Error('not implemented');
  }
  getChat(): never {
    throw new Error('not implemented');
  }
  updateChat(): never {
    throw new Error('not implemented');
  }
  listChats(): never {
    throw new Error('not implemented');
  }
  claimChat(): never {
    throw new Error('not implemented');
  }
  appendMessage(): never {
    throw new Error('not implemented');
  }
  listMessages(): never {
    throw new Error('not implemented');
  }
  getQueueCounts(): never {
    throw new Error('not implemented');
  }
}
