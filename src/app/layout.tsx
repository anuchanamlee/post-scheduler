import type { ReactNode } from 'react';
import './globals.css';
import BottomNav from './BottomNav.js';

export const metadata = {
  title: 'คิวโพสต์',
  description: 'ตั้งเวลาโพสต์ Facebook + Instagram',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        {children}
        {/* มีเฉพาะจอแคบ — ดู .bottom-nav ใน globals.css */}
        <BottomNav />
      </body>
    </html>
  );
}
