import type { ReactNode } from 'react';
import 'livechat-bridge/react/widget.css';
import 'livechat-bridge/react/admin.css';
import './globals.css';

export const metadata = {
  title: 'livechat-bridge demo',
  description: 'Drop-in live chat widget + admin dashboard + AI fallback.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
