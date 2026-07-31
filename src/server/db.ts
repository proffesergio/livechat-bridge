/**
 * Mongoose connection helper.
 *
 * Serverless runtimes re-enter the module on every cold-ish invocation but keep
 * the process alive between them, so a module-level variable is not enough —
 * bundlers and route isolation can hand each route its own module instance.
 * Caching on `globalThis` is the standard Next.js pattern and is what keeps a
 * lambda from opening a new connection pool per request.
 */

import mongoose from 'mongoose';

interface ConnectionCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

const CACHE_KEY = '__livechatBridgeMongoose__';

type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: ConnectionCache };

function cache(): ConnectionCache {
  const g = globalThis as GlobalWithCache;
  const existing = g[CACHE_KEY];
  if (existing) return existing;
  const created: ConnectionCache = { conn: null, promise: null };
  g[CACHE_KEY] = created;
  return created;
}

/**
 * Connects (or reuses an existing connection) and resolves with mongoose.
 *
 * Concurrent callers share one in-flight promise; a failed attempt clears it so
 * the next request retries rather than being stuck with a rejected promise.
 */
export async function connectDb(uri?: string): Promise<typeof mongoose> {
  const c = cache();
  if (c.conn) return c.conn;

  const connectionString = uri ?? process.env['MONGODB_URI'];
  if (!connectionString) {
    throw new Error('livechat-bridge: no Mongo URI provided (pass `mongoUri` or set MONGODB_URI)');
  }

  if (!c.promise) {
    c.promise = mongoose
      .connect(connectionString, {
        // The bridge issues short, indexed queries; buffering hides connection
        // problems behind a 10s stall instead of failing fast.
        bufferCommands: false,
      })
      .catch((err: unknown) => {
        c.promise = null;
        throw err;
      });
  }

  c.conn = await c.promise;
  return c.conn;
}

/** Tears the cached connection down. Intended for tests and graceful shutdown. */
export async function disconnectDb(): Promise<void> {
  const c = cache();
  if (c.conn) await c.conn.disconnect();
  c.conn = null;
  c.promise = null;
}
