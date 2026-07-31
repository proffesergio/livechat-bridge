/**
 * ID generator. Uses `crypto.randomUUID` where available (Node 19+, modern
 * browsers) and falls back to a base-36 random string. Adapters are free to
 * supply their own (e.g. Mongo ObjectId) — this is only the default.
 */
export function createId(prefix?: string): string {
  const raw =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix ? `${prefix}_${raw}` : raw;
}
