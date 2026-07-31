import en from './en.json';
import bn from './bn.json';

export type Locale = 'en' | 'bn' | (string & {});
export type Messages = Record<string, string>;

const LOCALES: Record<string, Messages> = { en, bn };

export function getMessages(locale: Locale): Messages {
  return LOCALES[locale] ?? en;
}

/**
 * Resolve a translation key, substituting `{name}`-style placeholders.
 * Falls back to English, then to the key itself, so the UI never renders an
 * empty string.
 */
export function t(messages: Messages, key: string, vars?: Record<string, string>): string {
  const raw = messages[key] ?? (en as Messages)[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}
