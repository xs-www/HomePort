/**
 * 服务管理页 `/admin/services`（仅管理员）。
 *
 * 职责：服务列表（按 `sortOrder`）+ 上移/下移排序、收藏、可见性切换、编辑、
 * 新建自定义服务、删除（手工）/ 隐藏（自动）/ 重置为自动、"重新发现"、一次性健康探测。
 *
 * 两条刻意保留的语义：
 * - **删除语义不同**：`manual` 服务是真删除；自动发现的服务只能"隐藏"或"重置为自动"
 *   （容器临时没起来就删掉用户配置，是这类面板最容易犯的错）。
 * - **写操作一律显示后端错误**：`ApiError.message` / `fieldErrors` 原样呈现，
 *   让"只允许 http/https"这类校验原因看得见。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ServiceListResponse, ServiceView } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Modal } from '../components/Modal.js';
import { ServiceForm } from '../components/ServiceForm.js';
import { ServiceIcon } from '../components/ServiceIcon.js';
import { ServiceStatusBadges } from '../components/ServiceCard.js';
import { Badge, Card, EmptyState, ErrorNotice, Icon, Skeleton } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { formatLatency } from '../lib/format.js';

type Editor = { mode: 'create' } | { mode: 'edit'; service: ServiceView } | null;

export function AdminServicesPage(): ReactNode {
  const { api } = useAuth();

  const load = useCallback(() => api.services({ includeHidden: true }), [api]);
  const { data, loading, error, reload } = useAsync<ServiceListResponse>(load, { refreshIntervalMs: 30_000 });

  const [editor, setEditor] = useState<Editor>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const items = useMemo(() => {
    const list = (data?.items ?? []).slice();
    list.sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.displayName.localeCompare(b.displayName, 'zh')));
    return list;
  }, [data?.items]);

  /** 统一处理"一次写操作 + 错误呈现 + 刷新"。 */
  const run = async (id: string | null, action: () => Promise<void>, success?: string): Promise<void> => {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      await reload();
      if (success) setNotice(success);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const move = (service: ServiceView, delta: -1 | 1): void => {
    const from = items.findIndex((item) => item.id === service.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= items.length) return;
    const next = items.slice();
    const moved = next.splice(from, 1)[0];
    if (!moved) return;
    next.splice(to, 0, moved);
    const order = next.map((item, index) => ({ id: item.id, sortOrder: (index + 1) * 10 }));
    void run(service.id, async () => {
      await api.reorderServices(order);
    });
  };

  const toggleFavorite = (service: ServiceView): void => {
    void run(service.id, async () => {
      await api.updateService(service.id, { favorite: !service.favorite });
    });
  };

  const toggleVisibility = (service: ServiceView): void => {
    const next = service.visibility === 'visible' ? 'hidden' : 'visible';
    void run(service.id, async () => {
      await api.updateService(service.id, { visibility: next });
    }, next === 'hidden' ? `已隐藏「${service.displayName}」` : `已恢复显示「${service.displayName}」`);
  };

  /**
   * 删除入口。
   *
   * `manual` → 永久删除（需要二次确认）；自动发现的服务 → 只隐藏（`DELETE` 不带 mode 时后端就是这么做的），
   * 隐藏是**可逆**操作（再次打开可见性开关即可），因此不再弹确认框：既少一次打断，
   * 也让自动化测试不必处理原生 confirm 对话框。
   */
  const remove = (service: ServiceView): void => {
    const manual = service.sourceType === 'manual';
    if (manual) {
      const message = `确定删除「${service.displayName}」？该服务是手工创建的，删除后无法自动恢复。`;
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)) return;
    }

    void run(service.id, async () => {
      await api.deleteService(service.id);
    }, manual ? `已删除「${service.displayName}」` : `已隐藏「${service.displayName}」`);
  };

  /** 重置为自动：清掉全部用户覆盖（`user_edited=0`）。 */
  const reset = (service: ServiceView): void => {
    const message = `确定把「${service.displayName}」重置为自动发现值？名称/图标/分类/首选入口/顺序/收藏等自定义都会被清除。`;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)) return;

    void run(service.id, async () => {
      await api.deleteService(service.id, 'reset');
    }, `已重置「${service.displayName}」为自动发现值`);
  };

  const probe = (service: ServiceView): void => {
    void run(service.id, async () => {
      const response = await api.probeServiceHealth(service.id);
      setNotice(
        `「${service.displayName}」健康探测：${response.health.state === 'ok' ? '通过' : '失败'}` +
          `${response.health.statusCode !== null ? ` · HTTP ${response.health.statusCode}` : ''} · ${formatLatency(response.health.durationMs)}`,
      );
    });
  };

  const rediscover = (): void => {
    setDiscovering(true);
    setActionError(null);
    setNotice(null);
    void api
      .discoverServices()
      .then((response) => {
        setNotice(`已重新发现：当前 ${response.total} 个服务`);
        return reload();
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : '重新发现失败');
      })
      .finally(() => setDiscovering(false));
  };

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-xs">
          {data
            ? `共 ${data.total} 个服务（含隐藏）· Docker 数据源 ${data.discovery.dockerAvailable ? '可用' : '不可读'} · Serve 数据源 ${
                data.discovery.serveAvailable ? '可用' : '不可读'
              }`
            : '正在读取服务…'}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost" onClick={rediscover} disabled={discovering}>
            <Icon name="refresh" className="size-3.5" />
            {discovering ? '发现中…' : '重新发现'}
          </button>
          {/* 列表非空时才在这里放「新建服务」：空态由 EmptyState 提供，
              避免同一个可访问名出现两次（读屏与 E2E 的选择器都会有歧义） */}
          {items.length > 0 ? (
            <button type="button" className="btn btn-primary" onClick={() => setEditor({ mode: 'create' })}>
              <Icon name="plus" className="size-3.5" />
              新建服务
            </button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}
      {actionError ? <ErrorNotice message={actionError} /> : null}
      {notice ? (
        <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}

      {loading && !data ? (
        <Card>
          <Skeleton rows={6} />
        </Card>
      ) : null}

      {data && items.length === 0 ? (
        <Card>
          <EmptyState
            title="还没有任何服务"
            description="可以新建一个自定义服务，或点击“重新发现”从 Docker 与 Tailscale Serve 重新索引。"
            icon={<Icon name="container" className="size-8" />}
            action={
              <button type="button" className="btn btn-primary" onClick={() => setEditor({ mode: 'create' })}>
                新建服务
              </button>
            }
          />
        </Card>
      ) : null}

      {items.length > 0 ? (
        <Card
          title="服务列表"
          subtitle="排序值越小越靠前；自动发现的服务不能被删除，只能隐藏或重置为自动"
          bodyClassName="px-3 py-3 sm:px-4"
        >
          <ul className="divide-y divide-slate-200/70 dark:divide-white/6">
            {items.map((service, index) => (
              <li key={service.id} className="flex flex-wrap items-start gap-3 py-3" data-service-id={service.id}>
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-300">
                  <ServiceIcon icon={service.icon} className="size-5" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link to={`/services/${encodeURIComponent(service.id)}`} className="truncate text-sm font-medium hover:text-sky-500">
                      {service.displayName}
                    </Link>
                    <Badge tone="idle" title={`source: ${service.sourceRef}`}>
                      {service.sourceType}
                    </Badge>
                    <Badge tone="idle" title="排序值">
                      #{service.sortOrder}
                    </Badge>
                    {service.visibility === 'hidden' ? <Badge tone="warn">已隐藏</Badge> : null}
                    {service.favorite ? <Badge tone="warn">已收藏</Badge> : null}
                    {service.userEdited ? (
                      <Badge tone="brand" title="用户改过展示属性，自动发现不再覆盖">
                        已定制
                      </Badge>
                    ) : null}
                  </div>
                  <p className="muted mt-1 truncate text-[11px]">
                    {(service.category ?? '').trim() || '未分类'}
                    {service.container ? ` · 容器 ${service.container.name}` : ''}
                    {service.entry ? ` · ${service.entry}` : ' · 无可达入口'}
                  </p>
                  <ServiceStatusBadges status={service.status} className="mt-1.5" />
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-1 text-[11px]"
                    disabled={index === 0 || busyId === service.id}
                    onClick={() => move(service, -1)}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-1 text-[11px]"
                    disabled={index === items.length - 1 || busyId === service.id}
                    onClick={() => move(service, 1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-1 text-[11px]"
                    aria-pressed={service.favorite}
                    disabled={busyId === service.id}
                    onClick={() => toggleFavorite(service)}
                  >
                    {service.favorite ? '取消收藏' : '收藏'}
                  </button>
                  {/* 可见性用开关，而不是又一个「隐藏」按钮：同行还有一个语义为“隐藏自动服务”的按钮
                      也叫「隐藏」，同名按钮会让读屏与 E2E 选择器产生歧义 */}
                  <label className="btn btn-ghost cursor-pointer px-2 py-1 text-[11px]">
                    <input
                      type="checkbox"
                      className="size-3 accent-sky-500"
                      checked={service.visibility === 'visible'}
                      disabled={busyId === service.id}
                      aria-label={`在服务墙显示「${service.displayName}」`}
                      onChange={() => toggleVisibility(service)}
                    />
                    显示
                  </label>
                  <button type="button" className="btn btn-ghost px-2 py-1 text-[11px]" onClick={() => setEditor({ mode: 'edit', service })}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-1 text-[11px]"
                    disabled={busyId === service.id}
                    onClick={() => probe(service)}
                  >
                    健康检查
                  </button>
                  {service.sourceType === 'manual' ? (
                    <button
                      type="button"
                      className="btn btn-danger px-2 py-1 text-[11px]"
                      disabled={busyId === service.id}
                      onClick={() => remove(service)}
                    >
                      删除
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-danger px-2 py-1 text-[11px]"
                        disabled={busyId === service.id}
                        onClick={() => remove(service)}
                      >
                        隐藏
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost px-2 py-1 text-[11px]"
                        disabled={busyId === service.id}
                        onClick={() => reset(service)}
                      >
                        重置为自动
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === 'edit' ? '编辑服务' : '新建服务'}
        description={editor?.mode === 'edit' ? editor.service.displayName : '手工创建的服务不参与自动发现'}
        size="lg"
      >
        {editor ? (
          <ServiceForm
            key={editor.mode === 'edit' ? editor.service.id : 'new'}
            service={editor.mode === 'edit' ? editor.service : null}
            onCancel={() => setEditor(null)}
            onSaved={async () => {
              setEditor(null);
              setNotice(editor.mode === 'edit' ? '已保存修改' : '已创建自定义服务');
              await reload();
            }}
          />
        ) : null}
      </Modal>
    </Shell>
  );
}