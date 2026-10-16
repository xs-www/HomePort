/**
 * 服务卡片（首页服务墙、管理页复用）与服务状态点。
 *
 * 最关键的一条产品语义（spec §3.4）：**三个状态维度永远分开**。
 * 容器是否在跑、入口是否可达、健康检查是否通过是三个独立事实，
 * 合并成一句"服务挂了"会让用户完全不知道该去重启容器还是去查端口映射。
 * 因此这里渲染三个独立的 `Badge`，各自带 `title` 悬停解释，且带 `data-status` 便于 E2E 断言。
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ServiceStatusView, ServiceView } from '../api/types.js';
import { ServiceIcon } from './ServiceIcon.js';
import { UrlCandidateList } from './UrlCandidateList.js';
import { Badge, Icon } from './ui.js';

type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'brand';

interface StatusPoint {
  key: 'container' | 'reachable' | 'health';
  tone: Tone;
  label: string;
  title: string;
}

/** 容器维度 → 文案（`null` = 没有容器绑定，不是"坏了"）。 */
function containerPoint(status: ServiceStatusView): StatusPoint {
  switch (status.container) {
    case 'running':
      return { key: 'container', tone: 'ok', label: '容器运行中', title: '容器正在运行' };
    case 'stopped':
      return { key: 'container', tone: 'warn', label: '容器未运行', title: '容器存在但没有在运行' };
    case 'absent':
      return { key: 'container', tone: 'bad', label: '容器不存在', title: '未找到对应容器（可能已删除或尚未启动）' };
    default:
      return { key: 'container', tone: 'idle', label: '无容器', title: '该服务没有容器绑定（纯 Serve 或手工服务）' };
  }
}

/** 可达维度 → 文案（`null` = 数据源不可用，**不确定 ≠ 不可达**）。 */
function reachablePoint(status: ServiceStatusView): StatusPoint {
  if (status.reachable === true) {
    return { key: 'reachable', tone: 'ok', label: '入口可达', title: '首选入口在 tailnet / 局域网内可访问' };
  }
  if (status.reachable === false) {
    return { key: 'reachable', tone: 'bad', label: '入口不可达', title: '所有候选入口都只能在宿主机本机访问' };
  }
  return { key: 'reachable', tone: 'idle', label: '可达性未知', title: '数据源不可用，无法判定入口可达性（不确定 ≠ 不可达）' };
}

/** 健康维度 → 文案（`skipped` 是默认状态：没配置就**不探测**）。 */
function healthPoint(status: ServiceStatusView): StatusPoint {
  switch (status.health) {
    case 'ok':
      return { key: 'health', tone: 'ok', label: '健康正常', title: '最近一次健康探测通过' };
    case 'fail':
      return { key: 'health', tone: 'bad', label: '健康检查失败', title: '最近一次健康探测未通过' };
    case 'unknown':
      return { key: 'health', tone: 'warn', label: '健康未探测', title: '已配置健康目标，但尚未执行探测' };
    default:
      return { key: 'health', tone: 'idle', label: '未配置健康检查', title: '没有配置健康目标（默认不探测）' };
  }
}

export interface ServiceStatusBadgesProps {
  status: ServiceStatusView;
  className?: string;
}

/** 三个独立状态点（卡片与详情页共用同一种语义）。 */
export function ServiceStatusBadges({ status, className = '' }: ServiceStatusBadgesProps): ReactNode {
  const points: StatusPoint[] = [containerPoint(status), reachablePoint(status), healthPoint(status)];

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {points.map((point) => (
        <span key={point.key} data-status={point.key}>
          <Badge tone={point.tone} dot pulse={point.key === 'container' && status.container === 'running'} title={point.title}>
            {point.label}
          </Badge>
        </span>
      ))}
    </div>
  );
}

/** 来源类型 → 中文。 */
export function describeSourceType(sourceType: ServiceView['sourceType']): string {
  switch (sourceType) {
    case 'docker':
      return 'Docker 自动发现';
    case 'serve':
      return 'Serve 路由';
    default:
      return '手工创建';
  }
}

export interface ServiceCardProps {
  service: ServiceView;
  /** 是否渲染管理入口（管理员才给 true；viewer 必须为 false） */
  canManage?: boolean;
  /** 点击「编辑」（仅管理员传） */
  onEdit?: (service: ServiceView) => void;
  /** 点击收藏/取消收藏（仅管理员传） */
  onToggleFavorite?: (service: ServiceView) => void;
  /** 管理动作进行中（禁用按钮） */
  busy?: boolean;
  /** 卡片默认展开候选入口列表 */
  defaultExpanded?: boolean;
  /** 名称链接目标（默认服务详情页） */
  to?: string;
}

export function ServiceCard({
  service,
  canManage = false,
  onEdit,
  onToggleFavorite,
  busy = false,
  defaultExpanded = false,
  to,
}: ServiceCardProps): ReactNode {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const detailPath = to ?? `/services/${encodeURIComponent(service.id)}`;
  const category = (service.category ?? '').trim();

  return (
    <article className="card card-hover flex flex-col px-4 py-4" data-service-id={service.id}>
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-300">
          <ServiceIcon icon={service.icon} className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link
              to={detailPath}
              className="block min-w-0 truncate text-sm font-semibold hover:text-sky-500"
              title={service.displayName}
            >
              {service.displayName}
            </Link>
            {canManage && onToggleFavorite ? (
              <button
                type="button"
                className="shrink-0 rounded-lg px-1.5 py-1 text-xs leading-none hover:bg-slate-100 dark:hover:bg-white/8"
                aria-label={service.favorite ? `取消收藏 ${service.displayName}` : `收藏 ${service.displayName}`}
                aria-pressed={service.favorite}
                disabled={busy}
                onClick={() => onToggleFavorite(service)}
              >
                <span aria-hidden className={service.favorite ? 'text-amber-500' : 'muted'}>
                  {service.favorite ? '★' : '☆'}
                </span>
              </button>
            ) : null}
          </div>
          <p className="muted mt-0.5 truncate text-[11px]" title={service.description ?? undefined}>
            {category !== '' ? category : '未分类'}
            {service.description ? ` · ${service.description}` : ''}
          </p>
        </div>
      </header>

      {/* 三个独立状态点：容器 / 入口可达 / 健康 */}
      <ServiceStatusBadges status={service.status} className="mt-3" />

      {/* 首选入口 */}
      <div className="mt-3 flex-1 space-y-1.5">
        {service.entry ? (
          <a
            href={service.entry}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between gap-2 rounded-xl bg-sky-500/12 px-3 py-2 text-xs ring-1 ring-sky-500/25 transition hover:bg-sky-500/20"
            title={service.entry}
          >
            <span className="min-w-0 break-all font-mono">{service.entry}</span>
            <Icon name="external" className="size-3.5 shrink-0 opacity-60" />
          </a>
        ) : (
          <p className="muted rounded-xl bg-slate-500/8 px-3 py-2 text-[11px] leading-relaxed">
            暂无可达入口 —— 候选入口可能都只能在本机访问，展开下方列表查看原因
          </p>
        )}

        {service.entryCount > 1 ? (
          <button
            type="button"
            className="btn btn-ghost w-full px-2 py-1.5 text-[11px]"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起候选入口' : `查看所有候选入口（${service.entryCount}）`}
          </button>
        ) : null}

        {expanded ? <UrlCandidateList entries={service.entries} className="pt-1" /> : null}
      </div>

      {/* 面向人的状态解释 */}
      {service.status.reasons.length > 0 ? (
        <ul className="muted mt-3 space-y-1 text-[11px] leading-relaxed">
          {service.status.reasons.map((reason, index) => (
            <li key={`${index}-${reason}`} className="flex items-start gap-1.5">
              <span aria-hidden className="mt-px opacity-70">
                ·
              </span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <footer className="mt-3 flex items-center justify-between gap-2 border-t border-slate-200/70 pt-2.5 dark:border-white/6">
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge tone="idle" title={describeSourceType(service.sourceType)}>
            {service.sourceType}
          </Badge>
          {service.userEdited ? (
            <Badge tone="brand" title="展示属性被管理员改过，自动发现不再覆盖">
              已定制
            </Badge>
          ) : null}
          {service.visibility === 'hidden' ? <Badge tone="warn">已隐藏</Badge> : null}
        </span>
        {canManage && onEdit ? (
          <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" disabled={busy} onClick={() => onEdit(service)}>
            编辑
          </button>
        ) : null}
      </footer>
    </article>
  );
}