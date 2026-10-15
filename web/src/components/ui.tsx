/**
 * 可复用 UI 原子组件。
 *
 * 约定：所有组件只关心展示，不含数据获取逻辑；数据由页面传入。
 */
import type { ReactNode } from 'react';
import { formatPercent } from '../lib/format.js';

type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'brand';

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-300 ring-1 ring-emerald-500/25',
  warn: 'bg-amber-500/12 text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/25',
  bad: 'bg-rose-500/12 text-rose-600 dark:text-rose-300 ring-1 ring-rose-500/25',
  idle: 'bg-slate-500/10 text-slate-600 dark:text-ink-300 ring-1 ring-slate-400/20',
  brand: 'bg-sky-500/12 text-sky-600 dark:text-sky-300 ring-1 ring-sky-500/25',
};

const DOT_CLASSES: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  idle: 'bg-slate-400',
  brand: 'bg-sky-500',
};

/** 状态徽标（可带脉冲圆点）。`children` 可省略，此时只渲染圆点。 */
export function Badge({
  tone = 'idle',
  children,
  dot = false,
  pulse = false,
  title,
}: {
  tone?: Tone;
  children?: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  title?: string;
}): ReactNode {
  return (
    <span className={`badge ${TONE_CLASSES[tone]}`} title={title}>
      {dot ? (
        <span className={`size-1.5 rounded-full ${DOT_CLASSES[tone]} ${pulse ? 'pulse-online' : ''}`} aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

/** 通用卡片容器。 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): ReactNode {
  return (
    <section className={`card fade-in ${className}`}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-5 py-3.5 dark:border-white/8">
          <div className="min-w-0">
            {title ? <h2 className="truncate text-sm font-semibold">{title}</h2> : null}
            {subtitle ? <p className="muted mt-0.5 text-xs">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`px-5 py-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** 进度条（自带阈值配色）。 */
export function ProgressBar({
  percent,
  label,
  hint,
  height = 8,
  thresholds = [70, 88],
}: {
  percent: number | null | undefined;
  label?: string;
  hint?: ReactNode;
  height?: number;
  thresholds?: [number, number];
}): ReactNode {
  const value = percent === null || percent === undefined || !Number.isFinite(percent) ? null : Math.min(100, Math.max(0, percent));

  const barColor =
    value === null
      ? 'bg-slate-400/40'
      : value >= thresholds[1]
        ? 'bg-gradient-to-r from-rose-500 to-rose-400'
        : value >= thresholds[0]
          ? 'bg-gradient-to-r from-amber-500 to-amber-400'
          : 'bg-gradient-to-r from-emerald-500 to-sky-500';

  return (
    <div>
      {label || hint ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          {label ? <span className="muted text-xs">{label}</span> : <span />}
          <span className="font-mono text-xs tabular-nums">{hint ?? formatPercent(value)}</span>
        </div>
      ) : null}
      <div
        className="w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/8"
        style={{ height }}
        role="progressbar"
        aria-valuenow={value ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${barColor}`}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/** 大号指标卡（概览页使用）。 */
export function StatCard({
  label,
  value,
  sub,
  tone = 'idle',
  percent,
  icon,
  footer,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  percent?: number | null;
  icon?: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <div className="card card-hover px-5 py-4">
      <div className="flex items-start justify-between gap-2">
        <span className="muted text-xs font-medium tracking-wide">{label}</span>
        {icon ? <span className={`rounded-lg p-1.5 ${TONE_CLASSES[tone]}`}>{icon}</span> : null}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {percent !== undefined ? (
        <div className="mt-2.5">
          <ProgressBar percent={percent} height={6} />
        </div>
      ) : null}
      {sub ? <div className="muted mt-2 text-xs">{sub}</div> : null}
      {footer ? <div className="mt-2.5">{footer}</div> : null}
    </div>
  );
}

/** 键值对行。 */
export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="muted shrink-0 text-xs">{label}</span>
      <span className="min-w-0 text-right text-xs break-all">{children}</span>
    </div>
  );
}

/** 数据源状态提示条：不可用/降级时给出原因。 */
export function SourceNotice({
  status,
  compact = false,
}: {
  status: { available: boolean; mode: string; detail: string | null };
  compact?: boolean;
}): ReactNode {
  if (status.available && status.mode !== 'container-proc' && status.mode !== 'os-cpus') return null;
  const degraded = status.available;
  return (
    <div
      className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${
        degraded
          ? 'bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300'
          : 'bg-rose-500/10 text-rose-700 ring-1 ring-rose-500/25 dark:text-rose-300'
      }`}
    >
      <span aria-hidden>{degraded ? '⚠' : '✕'}</span>
      <span className={compact ? 'line-clamp-2' : ''}>{status.detail ?? (degraded ? '数据源已降级' : '数据源不可用')}</span>
    </div>
  );
}

/** 空状态。 */
export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? <div className="muted mb-1">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="muted max-w-md text-xs">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** 加载指示器。 */
export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <span className="muted inline-flex items-center gap-2 text-xs">
      <span
        className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden
      />
      {label ?? '加载中…'}
    </span>
  );
}

/** 整块骨架屏。 */
export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-4 animate-pulse rounded bg-slate-200/70 dark:bg-white/8" />
      ))}
    </div>
  );
}

/** 错误提示条。 */
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-500/25 dark:text-rose-300">
      <span className="flex items-start gap-2">
        <span aria-hidden>✕</span>
        <span>{message}</span>
      </span>
      {onRetry ? (
        <button type="button" className="shrink-0 underline hover:no-underline" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

/** 小图标集合（内联 SVG，避免引入图标依赖）。 */
export function Icon({ name, className = 'size-4' }: { name: string; className?: string }): ReactNode {
  const paths: Record<string, ReactNode> = {
    overview: <path d="M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z" />,
    container: <path d="M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10" />,
    devices: <path d="M4 5h16v10H4z M8 19h8 M12 15v4" />,
    system: <path d="M4 20V10 M10 20V4 M16 20v-7 M22 20H2" />,
    tools: <path d="M14.7 6.3a4 4 0 105.4 5.4l-4-4-1.4-1.4zM3 21l6-6" />,
    admin: <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />,
    cpu: <path d="M6 6h12v12H6z M9 1v4 M15 1v4 M9 19v4 M15 19v4 M1 9h4 M1 15h4 M19 9h4 M19 15h4" />,
    memory: <path d="M3 7h18v10H3z M7 7v-3 M12 7v-3 M17 7v-3 M7 20v-3 M12 20v-3 M17 20v-3" />,
    disk: <path d="M3 12h18 M5 12l2-7h10l2 7v7H5z M8 16h.01 M12 16h.01" />,
    gpu: <path d="M3 6h18v12H3z M7 10h4v4H7z M15 10h2 M15 14h2" />,
    external: <path d="M14 3h7v7 M21 3l-9 9 M19 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h5" />,
    refresh: <path d="M21 12a9 9 0 11-2.6-6.4M21 3v6h-6" />,
    logout: <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9" />,
    search: <path d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" />,
    warning: <path d="M12 9v4 M12 17h.01 M10.3 3.9L2 18a2 2 0 001.7 3h16.6A2 2 0 0022 18L13.7 3.9a2 2 0 00-3.4 0z" />,
    check: <path d="M20 6L9 17l-5-5" />,
    close: <path d="M18 6L6 18 M6 6l12 12" />,
    plus: <path d="M12 5v14 M5 12h14" />,
    key: <path d="M15 7a4 4 0 11-3.5 5.9L4 20.5V17H7v-3h3l1.5-1.5A4 4 0 0115 7z" />,
    user: <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 3a4 4 0 100 8 4 4 0 000-8z" />,
    sun: <path d="M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4 M12 5a7 7 0 100 14 7 7 0 000-14z" />,
    moon: <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
    menu: <path d="M3 6h18 M3 12h18 M3 18h18" />,
    log: <path d="M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5" />,
    shield: <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z M9 12l2 2 4-4" />,
  };

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name] ?? paths.overview}
    </svg>
  );
}
