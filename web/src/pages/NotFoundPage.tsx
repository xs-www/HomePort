/**
 * 404 页面。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../layout/AppShell.js';

export function NotFoundPage(): ReactNode {
  return (
    <AppShell title="页面不存在">
      <div className="card px-6 py-14 text-center">
        <p className="text-3xl">🧭</p>
        <h2 className="mt-3 text-base font-semibold">找不到这个页面</h2>
        <p className="muted mt-1 text-xs">路径可能已变更，或者链接输入有误。</p>
        <Link to="/" className="btn btn-primary mt-5 inline-flex">
          返回总览
        </Link>
      </div>
    </AppShell>
  );
}
