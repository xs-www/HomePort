/**
 * 页面外壳包装。
 *
 * App.tsx 的守卫只负责「能不能进」，这里负责「进来之后长什么样」。
 * 拆成独立组件的原因：守卫需要在 `Protected` 中直接返回 `<Navigate>`，
 * 而那样会绕过 AppShell（导航栏消失）。用本组件把外壳固定在页面内部，
 * 可以保证任何守卫分支都不会丢掉导航。
 */
import type { ReactNode } from 'react';
import { AppShell } from './AppShell.js';

export interface ShellProps {
  children: ReactNode;
  topbarExtra?: ReactNode;
  title?: string;
}

/** 带侧边导航的标准页面外壳。 */
export function Shell({ children, topbarExtra, title }: ShellProps): ReactNode {
  return (
    <AppShell topbarExtra={topbarExtra} title={title}>
      {children}
    </AppShell>
  );
}
