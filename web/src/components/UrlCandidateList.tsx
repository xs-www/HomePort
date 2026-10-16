/**
 * 候选入口列表（服务卡片的「查看所有候选入口」抽屉 + 服务详情页共用）。
 *
 * 为什么必须把**不可达**的入口也列出来：spec §3.3 要求"保留全部候选入口供诊断"。
 * 只显示能点的那个会让用户以为"只有这一个入口"，遇到打不开时无从排查；
 * 列出不可达项并明确标注（"仅本机/不可达"）才是诚实做法。
 */
import type { ReactNode } from 'react';
import type { ServiceEntryView } from '../api/types.js';
import { Badge, Icon } from './ui.js';

export interface UrlCandidateListProps {
  /** 候选入口（通常是 `service.entries` 或详情接口的 `candidates`） */
  entries: ServiceEntryView[];
  /** 空列表时的说明文案 */
  emptyHint?: string;
  className?: string;
}

/** 不可达入口的可见标注（`localhost` 单独措辞，避免把"仅本机"说成"坏了"）。 */
export function unreachableLabel(entry: ServiceEntryView): string {
  return entry.kind === 'localhost' ? '仅本机/不可达' : '不可达';
}

export function UrlCandidateList({ entries, emptyHint = '没有发现任何候选入口', className = '' }: UrlCandidateListProps): ReactNode {
  if (entries.length === 0) {
    return <p className={`muted text-[11px] ${className}`}>{emptyHint}</p>;
  }

  return (
    <ul className={`space-y-1.5 ${className}`}>
      {entries.map((entry, index) => (
        <li
          key={`${entry.kind}:${entry.url}:${index}`}
          data-entry-kind={entry.kind}
          data-entry-accessible={entry.accessible ? 'true' : 'false'}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs ring-1 ${
            entry.accessible ? 'bg-sky-500/8 ring-sky-500/20' : 'bg-slate-500/6 ring-slate-400/20'
          }`}
        >
          <span className="min-w-0 flex-1">
            {entry.accessible ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 break-all font-mono hover:text-sky-500"
                title={entry.url}
              >
                {entry.url}
                <Icon name="external" className="size-3 shrink-0 opacity-60" />
              </a>
            ) : (
              <span className="block break-all font-mono opacity-80" title={entry.url}>
                {entry.url}
              </span>
            )}
            {entry.detail ? <span className="muted mt-0.5 block text-[10px] break-all">{entry.detail}</span> : null}
          </span>

          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Badge tone="idle" title={`入口优先级 rank=${entry.rank}`}>
              {entry.label}
            </Badge>
            {entry.accessible ? (
              <Badge tone="ok" dot title="该入口在 tailnet / 局域网内可访问">
                可达
              </Badge>
            ) : (
              <Badge tone="warn" title="该入口只能在宿主机本机访问（或无法判定可达）">
                {unreachableLabel(entry)}
              </Badge>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}