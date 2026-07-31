import { useMemo } from 'react';
import { getMessages, t, type Locale, type Messages } from '../../i18n/index.js';

export interface I18nBundle {
  locale: Locale;
  messages: Messages;
  t: (key: string, vars?: Record<string, string>) => string;
}

export function useI18n(locale: Locale = 'en', overrides?: Partial<Messages>): I18nBundle {
  return useMemo(() => {
    const base = getMessages(locale);
    const messages: Messages = { ...base };
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) messages[key] = value;
      }
    }
    return {
      locale,
      messages,
      t: (key, vars) => t(messages, key, vars),
    };
  }, [locale, overrides]);
}

export type { Locale, Messages };
