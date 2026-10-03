import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '知序 Noltri',
  description: '个人知识编译系统 — 知识树主界面',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
