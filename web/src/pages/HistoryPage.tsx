/**
 * 历史趋势页（`/history` · Sprint 2 · S2-02）。
 *
 * 页面只做三件事：管住"查什么"的状态、把目标列表选好、把四类状态
 * （加载中 / 出错 / 没有可用目标 / 有数据或诚实空态）交给 `MetricsChart` 呈现。
 *
 * 为什么"切换指标必须重置目标"：`metric × target` 才是曲线的身份，
 * `host.cpu.percent` 的 `host` 与 `host.disk.percent` 的 `disk:C:` 完全不是一回事。
 * 沿用旧目标会得到一个 400（或更糟：一个看似成功的空曲线）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { metricByKey, type MetricTargetOption } from '../api/metrics.js';
import { MetricPicker, type MetricPickerValue } from '../components/MetricPicker.js';
import { MetricsChart } from '../components/MetricsChart.js';
import { Card, EmptyState, ErrorNotice, Icon } from '../components/ui.js';
import { useMetricsHistory, useMetricTargets } from '../hooks/useMetricsHistory.js';
import { Shell } from '../layout/Shell.js';

/** 默认指标：§1 里的第一项（宿主 CPU 使用率），任何环境都有 target `host`。 */
const DEFAULT_VALUE: MetricPickerValue = { metric: 'host.cpu.percent', target: '', range: '24h' };

function emptyTargetHint(kind: string | undefined): string {
  switch (kind) {
    case 'disk':
      return '没有读到磁盘：确认 PORTAL_DISK_MOUNTS 指向的挂载点可访问。';
    case 'container':
      return '没有已注册的容器服务：先在「服务管理」里完成一次发现，容器才有稳定身份。';
    case 'service':
      return '还没有服务：先在「服务管理」里发现或手工添加服务。';
    default:
      return '当前指标没有可用目标。';
  }
}

export function HistoryPage(): ReactNode {
  const [value, setValue] = useState<MetricPickerValue>(DEFAULT_VALUE);
  const targetsState = useMetricTargets(value.metric);
  const targets: readonly MetricTargetOption[] = targetsState.data ?? [];

  // 指标变了（或第一次加载）→ 自动选中第一个可用目标；保持选择的稳定，不来回跳
  useEffect(() => {
    if (targets.length === 0) return;
    if (targets.some((option) => option.value === value.target)) return;
    const first = targets[0];
    if (first) setValue((previous) => ({ ...previous, target: first.value }));
  }, [targets, value.target]);

  const history = useMetricsHistory({ metric: value.metric, target: value.target === '' ? null : value.target, range: value.range });
  const entry = metricByKey(value.metric);
  const noTargets = targetsState.loaded && !targetsState.loading && targets.length === 0;

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">历史趋势</p>
          <p className="muted mt-0.5 text-xs">
            后台采样按分钟/小时聚合落库；缺测处断开，不补 0
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void history.reload()}
          disabled={history.loading || value.target === ''}
        >
          <Icon name="refresh" className="size-3.5" />
          刷新
        </button>
      </div>

      <Card title="查询条件" subtitle="指标 × 目标 × 时间范围共同确定一条曲线">
        <MetricPicker
          value={value}
          targets={targets}
          targetsLoading={targetsState.loading}
          onChange={setValue}
        />
      </Card>

      {targetsState.error ? <ErrorNotice message={targetsState.error} onRetry={() => void targetsState.reload()} /> : null}

      {noTargets ? (
        <Card title="没有可用的目标">
          <EmptyState
            title="当前指标没有可用目标"
            description={emptyTargetHint(entry?.targetKind)}
            icon={<Icon name="warning" className="size-6" />}
          />
        </Card>
      ) : (
        <MetricsChart
          view={history.data}
          loading={history.loading}
          error={history.error}
          onRetry={() => void history.reload()}
        />
      )}
    </Shell>
  );
}