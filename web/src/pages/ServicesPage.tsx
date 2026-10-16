/**
 * 首页 = 服务墙（S1-04）。
 *
 * 数据只走聚合接口 `GET /api/services`：候选入口、可达性、容器状态都由服务端实时算好，
 * 前端**不再并行调 `/containers` 自己拼**（两套口径迟早会打架）。
 *
 * 结构（自上而下）：
 * 1. 搜索入口（点击 / `Ctrl/Cmd+K` 唤起命令面板）
 * 2. 数据源降级提示（`discovery` 必须透出，不能静默为空）
 * 3. 「收藏」区 → 分类分组（可折叠、未分类最后）
 * 4. 卡片网格（≥640px 两列、≥1024px 三列）
 *
 * 权限：viewer 只看得到 `visibility='visible'`（服务端已过滤），且**不渲染任何管理入口**。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ServiceDiscoveryState, ServiceListResponse, ServiceView } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useCommandPalette } from '../components/CommandPalette.js';
import { Modal } from '../components/Modal.js';
import { ServiceCard } from '../components/ServiceCard.js';
import { ServiceForm } from '../components/ServiceForm.js';
import { Card, EmptyState, ErrorNotice, Icon, Skeleton } from '../components/ui.js';
import { useAsync, useLocalState } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { formatRelative } from '../lib/format.js';

/** 未分类的展示名（后端 `DEFAULT_CATEGORY` 一致）。 */
const UNCATEGORIZED = '未分类';

interface ServiceGroup {
  key: string;
  title: string;
  services: ServiceView[];
}

/** 排序：`sortOrder` 升序 → 名称（稳定、可断言）。 */
function bySortOrder(a: ServiceView, b: ServiceView): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.displayName.localeCompare(b.displayName, 'zh');
}

/**
 * 分组：收藏置顶区 + 分类分组。
 *
 * 收藏项**不重复**出现在分类分组里：同一张卡出现两次会让 `getByRole('link', { name })`
 * 之类的选择器命中多个元素（E2E 会直接失败），也会让"墙上到底有几个服务"变得含糊。
 */
export function buildServiceGroups(
  items: ServiceView[],
  categories: string[],
): { favorites: ServiceView[]; groups: ServiceGroup[] } {
  const favorites = items.filter((item) => item.favorite).sort(bySortOrder);

  const byCategory = new Map<string, ServiceView[]>();
  for (const item of items) {
    if (item.favorite) continue;
    const key = (item.category ?? '').trim() || UNCATEGORIZED;
    const list = byCategory.get(key);
    if (list) list.push(item);
    else byCategory.set(key, [item]);
  }

  const known = categories.map((name) => name.trim()).filter((name) => name !== '' && name !== UNCATEGORIZED && byCategory.has(name));
  const extra = [...byCategory.keys()]
    .filter((name) => name !== UNCATEGORIZED && !known.includes(name))
    .sort((a, b) => a.localeCompare(b, 'zh'));

  const groups: ServiceGroup[] = [...known, ...extra].map((name) => ({
    key: name,
    title: name,
    services: (byCategory.get(name) ?? []).slice().sort(bySortOrder),
  }));

  // 「未分类」永远最后
  const uncategorized = byCategory.get(UNCATEGORIZED);
  if (uncategorized) {
    groups.push({ key: UNCATEGORIZED, title: UNCATEGORIZED, services: uncategorized.slice().sort(bySortOrder) });
  }

  return { favorites, groups };
}

/**
 * 降级提示文案。
 *
 * 后端 `notes` 是**面向人的解释**，必须原样透出；只有当后端没给对应说明时，
 * 才退回到这里的兜底句子（仍然明确写出"Docker"/"Serve"，便于用户与 E2E 定位）。
 */
export function discoveryMessages(discovery: ServiceDiscoveryState): string[] {
  const messages: string[] = [];

  if (!discovery.dockerAvailable) {
    messages.push(
      discovery.notes.find((note) => note.includes('Docker')) ??
        '未读到 Docker 数据源：容器状态与端口入口暂时无法判定（不确定 ≠ 不可达）。',
    );
  }
  if (!discovery.serveAvailable) {
    messages.push(
      discovery.notes.find((note) => note.includes('Serve')) ??
        (discovery.serveDetail
          ? `未读到 Tailscale Serve 配置：${discovery.serveDetail}（Serve 入口可能缺失，CLI 模式才可读取。）`
          : '未读到 Tailscale Serve 配置（Serve 入口可能缺失，CLI 模式才可读取）。'),
    );
  }
  // 其余说明一律附上，不静默丢弃
  for (const note of discovery.notes) {
    if (!messages.includes(note)) messages.push(note);
  }

  return messages;
}

function DiscoveryNotices({ discovery }: { discovery: ServiceDiscoveryState }): ReactNode {
  const messages = discoveryMessages(discovery);
  if (messages.length === 0) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300"
    >
      <span aria-hidden>⚠</span>
      <ul className="space-y-1">
        {messages.map((message, index) => (
          <li key={`${index}-${message}`}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

/** 分类分组（可折叠）。 */
function ServiceSection({
  title,
  services,
  collapsed,
  onToggle,
  canManage,
  onEdit,
  onToggleFavorite,
  busyId,
}: {
  title: string;
  services: ServiceView[];
  collapsed: boolean;
  onToggle: () => void;
  canManage: boolean;
  onEdit: (service: ServiceView) => void;
  onToggleFavorite: (service: ServiceView) => void;
  busyId: string | null;
}): ReactNode {
  return (
    <section className="space-y-3" data-service-group={title}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span aria-hidden className="muted text-xs">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="text-sm font-semibold">{title}</span>
        <span className="muted text-[11px]">{services.length}</span>
      </button>

      {collapsed ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              canManage={canManage}
              onEdit={canManage ? onEdit : undefined}
              onToggleFavorite={canManage ? onToggleFavorite : undefined}
              busy={busyId === service.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ServicesPage(): ReactNode {
  const { api, isAdmin } = useAuth();
  const navigate = useNavigate();
  const palette = useCommandPalette();

  const load = useCallback(() => api.services(), [api]);
  const { data, loading, error, reload } = useAsync<ServiceListResponse>(load, { refreshIntervalMs: 30_000 });

  const [collapsedGroups, setCollapsedGroups] = useLocalState<string[]>('hp-services-collapsed', []);
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; service: ServiceView } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { favorites, groups } = useMemo(
    () => buildServiceGroups(data?.items ?? [], data?.categories ?? []),
    [data?.items, data?.categories],
  );

  const toggleGroup = (key: string): void => {
    setCollapsedGroups(collapsedGroups.includes(key) ? collapsedGroups.filter((item) => item !== key) : [...collapsedGroups, key]);
  };

  const toggleFavorite = async (service: ServiceView): Promise<void> => {
    setBusyId(service.id);
    setActionError(null);
    try {
      await api.updateService(service.id, { favorite: !service.favorite });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '收藏失败');
    } finally {
      setBusyId(null);
    }
  };

  const closeEditor = useCallback((): void => setEditor(null), []);
  const refresh = reload;

  const isEmpty = data !== null && data.items.length === 0;
  const sectionProps = {
    canManage: isAdmin,
    onEdit: (service: ServiceView) => setEditor({ mode: 'edit', service }),
    onToggleFavorite: (service: ServiceView) => void toggleFavorite(service),
    busyId,
  };

  return (
    <Shell>
      {/* 搜索入口：点击打开命令面板，右侧提示快捷键 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="input flex min-w-0 flex-1 items-center justify-between gap-3 text-left sm:max-w-md"
          onClick={palette.open}
          aria-label="搜索服务、容器、设备与工具"
        >
          <span className="muted flex min-w-0 items-center gap-2 text-xs">
            <Icon name="search" className="size-4 shrink-0" />
            <span className="truncate">搜索服务、容器、设备与工具…</span>
          </span>
          <kbd className="muted shrink-0 rounded border border-slate-300/70 px-1.5 py-0.5 font-mono text-[10px] dark:border-white/12">
            Ctrl K
          </kbd>
        </button>

        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
          {/* 空态与加载中不在这里放「新建服务」：空态由 EmptyState 提供，
              避免同一个可访问名出现两次（读屏与 E2E 的选择器都会有歧义） */}
          {isAdmin && data !== null && data.items.length > 0 ? (
            <button type="button" className="btn btn-primary" onClick={() => setEditor({ mode: 'create' })}>
              <Icon name="plus" className="size-3.5" />
              新建服务
            </button>
          ) : null}
        </div>
      </div>

      {data ? <DiscoveryNotices discovery={data.discovery} /> : null}
      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}
      {actionError ? <ErrorNotice message={actionError} /> : null}

      {/* 加载 / 空态 */}
      {loading && !data ? (
        <Card>
          <Skeleton rows={6} />
        </Card>
      ) : null}

      {isEmpty && data ? (
        <Card>
          <EmptyState
            title="还没有发现任何服务"
            description={
              isAdmin
                ? '可以新建一个自定义服务，或检查 Docker / Tailscale Serve 数据源是否可读（上方提示条说明了原因）。'
                : '服务由管理员通过自动发现或手工添加；数据源不可用时上方提示条会说明原因。'
            }
            icon={<Icon name="container" className="size-8" />}
            action={
              isAdmin ? (
                <button type="button" className="btn btn-primary" onClick={() => setEditor({ mode: 'create' })}>
                  新建服务
                </button>
              ) : null
            }
          />
        </Card>
      ) : null}

      {/* 收藏区 */}
      {favorites.length > 0 ? (
        <ServiceSection title="收藏" services={favorites} {...sectionProps} collapsed={collapsedGroups.includes('收藏')} onToggle={() => toggleGroup('收藏')} />
      ) : null}

      {/* 分类分组 */}
      {groups.map((group) => (
        <ServiceSection
          key={group.key}
          title={group.title}
          services={group.services}
          {...sectionProps}
          collapsed={collapsedGroups.includes(group.key)}
          onToggle={() => toggleGroup(group.key)}
        />
      ))}

      {data && data.items.length > 0 ? (
        <p className="muted text-center text-[11px]">
          共 {data.total} 个服务 · 数据更新于 {formatRelative(data.generatedAt)}
          {isAdmin ? (
            <>
              {' · '}
              <button type="button" className="underline hover:no-underline" onClick={() => navigate('/admin/services')}>
                管理服务
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {/* 新建 / 编辑（与命令面板共用 Modal） */}
      <Modal
        open={editor !== null}
        onClose={closeEditor}
        title={editor?.mode === 'edit' ? '编辑服务' : '新建服务'}
        description={editor?.mode === 'edit' ? editor.service.displayName : '手工创建的服务不会随自动发现被覆盖'}
        size="lg"
      >
        {editor ? (
          <ServiceForm
            key={editor.mode === 'edit' ? editor.service.id : 'new'}
            service={editor.mode === 'edit' ? editor.service : null}
            onCancel={closeEditor}
            onSaved={async () => {
              closeEditor();
              await refresh();
            }}
          />
        ) : null}
      </Modal>
    </Shell>
  );
}