/**
 * 服务图标。
 *
 * `icon` 字段只有两种合法取值（见 spec §6）：
 * 1. **内置图标键**（白名单，与 `server/src/modules/services/registry.ts` 的 `BUILTIN_ICONS` 一致）→ 内联 SVG；
 * 2. `https://` 地址 → `<img loading="lazy" referrerPolicy="no-referrer">`。
 *
 * 其它一切（空值、未知键、`javascript:` / `data:` / `http:` 等）→ 一律回退到 `container`。
 * **绝不引入图标字体或 CDN**：默认 CSP 是 `img-src 'self' data:`，外链资源会被浏览器拦掉，
 * 那会让页面"看起来没坏但图标永远不出现"，且 E2E 会因此失败。
 */
import type { ReactNode } from 'react';

/**
 * 内置图标白名单。
 *
 * 顺序与后端 `BUILTIN_ICONS` 完全一致，管理页的图标候选直接用它。
 */
export const SERVICE_ICON_NAMES = [
  'homeport',
  'calendar',
  'git',
  'code',
  'container',
  'server',
  'disk',
  'network',
  'media',
  'music',
  'photo',
  'game',
  'book',
  'note',
  'dashboard',
  'monitoring',
  'backup',
  'mail',
  'chat',
  'cloud',
  'database',
  'shield',
  'tools',
  'link',
  'globe',
  'box',
] as const;

export type ServiceIconName = (typeof SERVICE_ICON_NAMES)[number];

/** 未知键的兜底（与后端 `FALLBACK_ICON` 一致）。 */
export const SERVICE_FALLBACK_ICON: ServiceIconName = 'container';

const ICON_PATHS: Record<ServiceIconName, ReactNode> = {
  homeport: <path d="M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-6h4v6" />,
  calendar: <path d="M4 5h16v15H4z M4 9h16 M8 3v4 M16 3v4 M8 13h2 M14 13h2 M8 16h2" />,
  git: <path d="M6 4v9 M6 20a2 2 0 100-4 2 2 0 000 4z M18 8a2 2 0 100-4 2 2 0 000 4z M18 8v2a4 4 0 01-4 4H9a3 3 0 00-3 3" />,
  code: <path d="M9 18l-6-6 6-6 M15 6l6 6-6 6" />,
  container: <path d="M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10" />,
  server: <path d="M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01" />,
  disk: <path d="M3 12h18 M5 12l2-7h10l2 7v7H5z M8 16h.01 M12 16h.01" />,
  network: <path d="M12 4a2 2 0 100 4 2 2 0 000-4z M5 16a2 2 0 100 4 2 2 0 000-4z M19 16a2 2 0 100 4 2 2 0 000-4z M12 8v4 M12 12l-5.5 4 M12 12l5.5 4" />,
  media: <path d="M3 5h18v14H3z M10 9l5 3-5 3z" />,
  music: <path d="M9 18V6l10-2v12 M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z M19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />,
  photo: <path d="M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M8.5 9.5h.01" />,
  game: <path d="M7 8h10a4 4 0 014 4v4a2 2 0 01-3.4 1.4L16 16H8l-1.6 1.4A2 2 0 013 16v-4a4 4 0 014-4z M8 12h3 M9.5 10.5v3 M16 11.5h.01 M17.5 13.5h.01" />,
  book: <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z M19 3v16 M8 8h6 M8 11h6" />,
  note: <path d="M6 3h9l4 4v14H6z M15 3v4h4 M9 12h7 M9 16h5" />,
  dashboard: <path d="M4 4h7v9H4z M13 4h7v5h-7z M13 13h7v7h-7z M4 17h7v3H4z" />,
  monitoring: <path d="M3 13h4l2.5-6 3 12 2.5-8 2 2h4" />,
  backup: <path d="M12 3v10 M8 9l4 4 4-4 M4 17h16v4H4z" />,
  mail: <path d="M3 6h18v12H3z M3 7l9 6 9-6" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  cloud: <path d="M7 18a4 4 0 010-8 5.5 5.5 0 0110.5 1.5A3.5 3.5 0 0118 18z" />,
  database: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />,
  tools: <path d="M14.7 6.3a4 4 0 105.4 5.4l-4-4-1.4-1.4zM3 21l6-6" />,
  link: <path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1 M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" />,
  globe: <path d="M12 21a9 9 0 100-18 9 9 0 000 18z M3 12h18 M12 3c2.4 2.6 3.6 5.6 3.6 9S14.4 18.4 12 21c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z" />,
  box: <path d="M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10 M7.5 5l9 4" />,
};

const ICON_SET: ReadonlySet<string> = new Set<string>(SERVICE_ICON_NAMES);

/** 是否为内置图标键。 */
export function isServiceIconName(value: string): value is ServiceIconName {
  return ICON_SET.has(value);
}

/** 是否为合法的**外部图标地址**（只接受 `https://`，与后端校验一致）。 */
export function isServiceIconUrl(value: string): boolean {
  return /^https:\/\/\S+$/i.test(value.trim());
}

export interface ServiceIconProps {
  /** 数据库里的 `icon` 值：内置键或 `https://` 地址（可空） */
  icon: string | null | undefined;
  className?: string;
  /** 外部图片的 alt（默认空串：图标是装饰性的，名称已在旁边） */
  alt?: string;
}

export function ServiceIcon({ icon, className = 'size-5', alt = '' }: ServiceIconProps): ReactNode {
  const raw = (icon ?? '').trim();

  // 外部图标：只放行 https，其它 scheme 一律走内置兜底（顺带挡掉 javascript:/data:）
  if (isServiceIconUrl(raw)) {
    return (
      <img
        src={raw}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`${className} object-contain`}
      />
    );
  }

  const name: ServiceIconName = isServiceIconName(raw) ? raw : SERVICE_FALLBACK_ICON;

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
      data-icon={name}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}