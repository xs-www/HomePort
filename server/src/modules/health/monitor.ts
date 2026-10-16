/**
 * 健康监视器（S2-03 §4.2）—— 编排层：取服务/容器 → 节流探测 → 纯状态机评估 → 存内存。
 *
 * 三条纪律（都是 Sprint 1 踩过坑换来的）：
 *
 * 1. **不新增出站请求**：容器维度与 docker health 用 `containers.list({all:true,stats:false})`
 *    的缓存结果（TTL 2s，每 tick 至多一次）。只有 `http` 维才发请求，且**复用
 *    `healthProbe.ts`**（SSRF 拒绝清单、3s 超时、16KB 响应体上限）—— 绕过它就等于
 *    把整个门户的 SSRF 防线绕过去。
 * 2. **探测失败不清空任何既有状态**：目标不可达只是"这一维 fail"，服务配置（DB）
 *    与内存里的历史判定都不受影响。Sprint 1 的教训："探不通"不等于"这个服务没配置过"。
 * 3. **并发上限是全局的、不是本 tick 的**：本轮最多 `concurrency` 个在飞探测，
 *    装不下的按 `sourceRef` 稳定排序推迟到下一 tick 并记入 `skippedForConcurrency`。
 *    为什么要全局：`tick()` 万一被并发调用（或上层没做单飞），"每 tick 几个"
 *    会退化成"每 tick 几乘调用次数个"，上限就形同虚设。
 *
 * 时钟一律经 `clock` 注入（默认 `Date.now`）；容器列表缓存也刻意用**注入时钟**判过期，
 * 而不是 `util/cache.ts` 的 `TtlCache`（后者读真实 `Date.now`）——
 * 否则测试里"推进时钟"对缓存不生效，TTL 行为就无法确定性验证。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { backgroundHostRequest } from '../docker/backgroundContext.js';
import type { ContainerListQuery, ContainerListResult, ContainerSummary } from '../docker/types.js';
import type { HostContextRequest } from '../docker/service.js';
import { containerServiceRef } from '../services/registry.js';
import { resolveHealthTarget } from '../services/service.js';
import type { ServiceRole, ServiceListQuery } from '../services/service.js';
import type { ServiceListResponse, ServiceView } from '../services/types.js';
import { HEALTH_PROBE_TIMEOUT_MS, type HealthProbeResult } from '../services/healthProbe.js';
import { evaluateHealth } from './state.js';
import {
  DEFAULT_FAIL_THRESHOLD,
  DEFAULT_OK_THRESHOLD,
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_PROBE_INTERVAL_SEC,
  MAX_TRACKED_SERVICES,
  isoFromMs,
  toEpochMs,
  type HealthDimensionKey,
  type HealthDimensionState,
  type HealthMonitorServiceView,
  type HealthMonitorView,
  type HealthProbeStats,
  type HealthSignal,
  type HealthTickResult,
  type ServiceHealthState,
} from './types.js';

// 调度器按模块路径 import 这个类型（`../health/monitor.js`），转出一次即可。
export type { HealthTickResult, HealthMonitorView, ServiceHealthState } from './types.js';

/** 容器列表快照的复用窗口（ms）：同一 tick 内与相邻 tick 之间都不重复问 Docker。 */
export const CONTAINER_SNAPSHOT_TTL_MS = 2000;

/** 容器状态 → 人话（面向管理员的证据文案，测试锁住）。 */
const CONTAINER_STATE_TEXT: Readonly<Record<string, string>> = {
  exited: '已退出',
  dead: '已死',
  restarting: '重启中',
  created: '未启动',
  paused: '已暂停',
  removing: '正在删除',
};

/** 只依赖结构的最小接口：不 import 对方的类，避免与并行改动耦合。 */
export interface HealthRegistrySource {
  list(request: HostContextRequest, query?: ServiceListQuery, role?: ServiceRole): Promise<ServiceListResponse>;
}

export interface HealthContainersSource {
  list(query: ContainerListQuery, request: HostContextRequest): Promise<ContainerListResult>;
}

export interface HealthMonitorDeps {
  config: PortalConfig;
  logger: Logger;
  registry: HealthRegistrySource;
  containers: HealthContainersSource;
  /**
   * 一次 HTTP 探测。**生产必须传 healthProbe 的适配器**：
   * `(target, options) => runHealthProbe({ target, timeoutMs: options?.timeoutMs })`。
   */
  probe: (target: string, options?: { timeoutMs?: number }) => Promise<HealthProbeResult>;
  clock?: () => number;
  /** 自动探测间隔（秒），0 = 关闭自动探测。未注入时用 `DEFAULT_PROBE_INTERVAL_SEC`。 */
  intervalSec?: () => number;
  /** 全局在飞探测上限。未注入时用 `DEFAULT_PROBE_CONCURRENCY`。 */
  concurrency?: () => number;
}

interface TrackedService {
  sourceRef: string;
  serviceId: string;
  label: string;
  target: string | null;
}

/**
 * 服务列表的读取结果。
 *
 * **必须**把"读失败"和"成功读到空列表"分成两种结果，否则监视器无法回答
 * "用户把服务全隐藏/全删了"与"这一次没读到服务列表"这个致命的问题：
 * 两者的 `items` 都是空数组，但前者要求**清空**旧状态（含服务名），后者要求**保留**。
 * 用 `ok` 这个判别字段承载区别，而不是靠"是否为空"去猜。
 */
type ServiceListViewResult = { ok: true; views: ServiceView[] } | { ok: false; views: [] };

export class HealthMonitor {
  private readonly deps: HealthMonitorDeps;
  private readonly log: Logger;
  private readonly clock: () => number;
  /** 服务健康状态：**只在内存**（进程重启即清空，重启后重新攒连续计数）。 */
  private readonly statesByRef = new Map<string, ServiceHealthState>();
  private readonly labelsByRef = new Map<string, { serviceId: string; label: string }>();
  /**
   * 最近一次**成功读取**到的可见服务集合（viewer 视角）。`null` = 还没有过成功读取，
   * 此时读路径不做过滤（无数据可漏）。读失败时**保持上一次的集合不变**：
   * 失败的读不能证明任何服务消失，扩大可见集合只会制造泄漏。
   */
  private visibleRefs: Set<string> | null = null;
  private containerSnapshot: { atMs: number; value: ContainerListResult } | null = null;
  private lastContainerError: string | null = null;
  private lastRegistryError: string | null = null;
  private lastRunAt: string | null = null;
  private probedThisTick = 0;
  private skippedForConcurrency = 0;
  private inFlight = 0;

  constructor(deps: HealthMonitorDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'health' });
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * 跑一轮：取服务与容器 → 决定谁该探测 → 探测（受全局并发上限约束）→ 逐服务评估。
   *
   * `now` 为毫秒时间戳（与注入 `clock` 的单位一致；秒制也能识别，见 `toEpochMs`）。
   */
  async tick(now: number): Promise<HealthTickResult> {
    const nowMs = toEpochMs(now);
    const at = isoFromMs(nowMs);
    const intervalSec = this.intervalSec();
    const concurrency = this.concurrency();
    const hostRequest = backgroundHostRequest(this.deps.config);

    const loaded = await this.loadServices(hostRequest);
    const views = loaded.views;
    const tracked: TrackedService[] = views
      .map((view) => ({
        sourceRef: view.sourceRef,
        serviceId: view.id,
        label: view.displayName,
        target: resolveHealthTarget({
          healthTarget: view.healthTarget,
          healthPath: view.healthPath,
          entry: view.entry,
        }),
      }))
      // 顺序稳定（按 sourceRef）→ 并发上限的"谁先谁后"可测、可复现。
      .sort((a, b) => (a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0));

    const live = await this.loadContainers(hostRequest, nowMs);

    // ---- 1) 决定本轮探测名单（按 sourceRef 稳定排序 → 可测） ----
    const due = intervalSec > 0 ? tracked.filter((item) => item.target !== null && this.isProbeDue(item.sourceRef, nowMs, intervalSec)) : [];
    const budget = Math.max(0, concurrency - this.inFlight);
    const batch = due.slice(0, budget);
    this.skippedForConcurrency = due.length - batch.length;
    this.probedThisTick = batch.length;

    const probeResults = await this.runProbes(batch, at);

    // ---- 2) 逐服务评估（每个服务每 tick 恰好评估一次） ----
    const containerIndex = this.buildContainerIndex(live);
    let failures = 0;
    for (const item of tracked) {
      const containers = this.containersFor(item.sourceRef, views, containerIndex);
      const result = probeResults.get(item.sourceRef) ?? null;
      if (result && result.state === 'fail') failures += 1;
      const previous = this.statesByRef.get(item.sourceRef) ?? null;
      const signal = this.buildSignal(item, containers, result, previous, at);
      const state = evaluateHealth(previous, signal, {
        failThreshold: DEFAULT_FAIL_THRESHOLD,
        okThreshold: DEFAULT_OK_THRESHOLD,
        at: nowMs,
      });
      this.statesByRef.set(item.sourceRef, state);
      this.labelsByRef.set(item.sourceRef, { serviceId: item.serviceId, label: item.label });
    }

    // 只有**成功读取**的服务列表才是"当前可见服务集合"的真相：
    // - 成功且非空 → 回收不在集合里的旧状态；
    // - 成功且**为空** → 用户把服务全隐藏/全删了，必须清掉**全部**旧状态，
    //   连 `labelsByRef` 里的服务名一起清（只清状态会留下名字，等于把 hidden 服务
    //   的名字继续透给 viewer —— 这正是 P1 缺陷）。
    // - 读失败（`ok === false`）→ **不碰**任何既有状态，`visibleRefs` 也保持不变，
    //   原因写在 `lastRegistryError` → 由 `view().notes` 说明（取数抖动 ≠ 服务消失）。
    if (loaded.ok) {
      this.visibleRefs = new Set(tracked.map((item) => item.sourceRef));
      this.dropStaleStates(tracked);
    }
    this.lastRunAt = at;

    return {
      at,
      evaluated: tracked.length,
      probed: batch.length,
      skippedForConcurrency: this.skippedForConcurrency,
      failures,
    };
  }

  /**
   * 当前跟踪到的全部服务状态（按 sourceRef 稳定排序）。
   *
   * 纵深防御：即便将来 reconcile（`dropStaleStates`）再出问题，这里也**绝不**把
   * "已不在最近一次成功读取的可见服务集合里"的状态发出去 —— 泄漏服务名是 P1 级问题，
   * 不能只靠写路径一处保证。集合为空 = 一个都不发（`null` = 还没成功读过，不过滤）。
   */
  states(): ServiceHealthState[] {
    return [...this.statesByRef.values()]
      .filter((state) => this.isVisible(state.sourceRef))
      .sort((a, b) => (a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0));
  }

  /** 单个服务的状态；同样受可见集合约束（不可见 = 当作不存在，不返回名字或判定）。 */
  state(sourceRef: string): ServiceHealthState | null {
    if (!this.isVisible(sourceRef)) return null;
    return this.statesByRef.get(sourceRef) ?? null;
  }

  /** 读路径的可见性判据：还没成功读过（`null`）时不做过滤，否则必须在集合里。 */
  private isVisible(sourceRef: string): boolean {
    return this.visibleRefs === null || this.visibleRefs.has(sourceRef);
  }

  probeStats(): HealthProbeStats {
    return {
      intervalSec: this.intervalSec(),
      concurrency: this.concurrency(),
      inFlight: this.inFlight,
      lastRunAt: this.lastRunAt,
      probedThisTick: this.probedThisTick,
      skippedForConcurrency: this.skippedForConcurrency,
    };
  }

  /**
   * `GET /api/health/monitor` 的响应体。
   *
   * 比规范的类方法表多一个 `view()`（纯组装，无副作用）：路由层不该知道"标签从哪来"，
   * 也不该散着拼 notes —— 降级原因必须与判定结论出现在同一个响应里。
   */
  view(): HealthMonitorView {
    const notes: string[] = [];
    const intervalSec = this.intervalSec();
    if (intervalSec <= 0) {
      notes.push('自动 HTTP 探测已关闭：只评估容器维度，http 维保持 unknown');
    }
    if (this.lastRegistryError) notes.push(`服务列表不可用：${this.lastRegistryError}`);
    if (this.lastContainerError) notes.push(`容器列表不可用：${this.lastContainerError}`);
    if (this.skippedForConcurrency > 0) {
      notes.push(`本 tick 有 ${this.skippedForConcurrency} 个服务的探测因并发上限推迟到下一 tick`);
    }
    const services: HealthMonitorServiceView[] = [];
    for (const state of this.states()) {
      const meta = this.labelsByRef.get(state.sourceRef);
      services.push({
        sourceRef: state.sourceRef,
        serviceId: state.serviceId,
        label: meta?.label ?? state.sourceRef,
        verdict: state.verdict,
        dimensions: state.dimensions,
        consecutiveFailures: state.consecutiveFailures,
        consecutiveSuccesses: state.consecutiveSuccesses,
        changedAt: state.changedAt,
        lastEvaluatedAt: state.lastEvaluatedAt,
        lastProbeAt: state.lastProbeAt,
        reasons: state.reasons,
      });
    }
    if (services.length === 0) notes.push('还没有可监测的服务（服务发现在后台 tick 完成后才会有数据）');

    return {
      generatedAt: isoFromMs(this.clock()),
      thresholds: { failThreshold: DEFAULT_FAIL_THRESHOLD, okThreshold: DEFAULT_OK_THRESHOLD },
      probe: this.probeStats(),
      services,
      notes,
    };
  }

  /* ---------------- 内部 ---------------- */

  private intervalSec(): number {
    const value = this.deps.intervalSec?.() ?? DEFAULT_PROBE_INTERVAL_SEC;
    if (!Number.isFinite(value) || value < 0) return DEFAULT_PROBE_INTERVAL_SEC;
    return Math.floor(value);
  }

  private concurrency(): number {
    const value = this.deps.concurrency?.() ?? DEFAULT_PROBE_CONCURRENCY;
    if (!Number.isFinite(value) || value < 1) return DEFAULT_PROBE_CONCURRENCY;
    return Math.floor(value);
  }

  /**
   * 取服务列表（viewer 视角：**hidden 服务不纳入监控**）。
   *
   * 用 viewer 而不是 admin 是刻意的：hidden 是用户"我不想看到它"的明确表达，
   * 后台却继续采它的健康指标并把名字写进 `/api/health/monitor`，等于绕过用户的隐藏。
   *
   * 返回值**带 `ok` 判别位**：`list()` 抛错 = 读失败；`list()` 正常返回（哪怕
   * `items` 为空）= 读成功。这个区别不能靠"数组是否为空"事后猜 —— 用户隐藏掉最后一个
   * 服务时 `items` 同样是空数组，那一次必须清理旧状态（见 `tick()`）。
   *
   * 顺带说明为什么"读失败 → 保留旧状态"在真实数据源上不会误伤：服务视图是
   * `repository.listAll()`（DB）逐条构建的，Docker 抖动只会让 `discovery.dockerAvailable`
   * 变 false、容器维度退化为 unknown，**不会**让 DB 里的服务从 `items` 消失。
   * 所以"非空列表 + 数据源降级"的场景本来就会被正常保留；真正的空列表只可能来自
   * "确实没有可见服务"。取数彻底失败（Docker/发现异常导致 `list()` 抛错）才走 `ok: false`。
   */
  private async loadServices(request: HostContextRequest): Promise<ServiceListViewResult> {
    try {
      const response = await this.deps.registry.list(request, {}, 'viewer');
      if (!Array.isArray(response?.items)) {
        // 契约破损（没有 items 数组）不能当成"服务全没了"：那是把响应错误当成用户意图。
        this.lastRegistryError = '服务列表响应缺少 items 数组';
        this.log.warn('健康监视器：服务列表响应不合法', { error: this.lastRegistryError });
        return { ok: false, views: [] };
      }
      this.lastRegistryError = null;
      return { ok: true, views: response.items };
    } catch (error) {
      // 服务列表取不到（发现失败 / Docker 不可用）：本 tick 不评估任何服务，
      // 但**已有的健康状态原样保留** —— 取数失败不等于服务恢复或消失。
      this.lastRegistryError = error instanceof Error ? error.message : String(error);
      this.log.warn('健康监视器：服务列表获取失败', { error: this.lastRegistryError });
      return { ok: false, views: [] };
    }
  }

  private async loadContainers(request: HostContextRequest, nowMs: number): Promise<ContainerListResult | null> {
    const cached = this.containerSnapshot;
    if (cached && nowMs - cached.atMs < CONTAINER_SNAPSHOT_TTL_MS) return cached.value;
    try {
      const value = await this.deps.containers.list({ all: true, stats: false }, request);
      this.containerSnapshot = { atMs: nowMs, value };
      this.lastContainerError = null;
      return value;
    } catch (error) {
      this.lastContainerError = error instanceof Error ? error.message : String(error);
      this.log.warn('健康监视器：容器列表获取失败', { error: this.lastContainerError });
      // 取不到就返回 null（容器维度退化为 unknown），**不拿过期快照冒充现状**：
      // 用几分钟前的容器状态说"容器还在跑"，比承认"不知道"更危险。
      return null;
    }
  }

  /** 本轮是否该探测：距上次**真的探过**不足 intervalSec 就不探（失败也算探过，避免打爆故障目标）。 */
  private isProbeDue(sourceRef: string, nowMs: number, intervalSec: number): boolean {
    const last = this.statesByRef.get(sourceRef)?.lastProbeAt;
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return true;
    return nowMs - lastMs >= intervalSec * 1000;
  }

  /**
   * 执行一批探测。
   *
   * 全局并发上限在**进入这一批之前**就已经按 `concurrency - inFlight` 裁剪过，
   * 因此这里的 `Promise.all` 在任何时刻都不会让在飞数超过上限。
   */
  private async runProbes(batch: readonly TrackedService[], at: string): Promise<Map<string, HealthProbeResult>> {
    const results = new Map<string, HealthProbeResult>();
    if (batch.length === 0) return results;
    this.inFlight += batch.length;
    try {
      await Promise.all(
        batch.map(async (item) => {
          const target = item.target as string;
          try {
            results.set(item.sourceRef, await this.deps.probe(target, { timeoutMs: HEALTH_PROBE_TIMEOUT_MS }));
          } catch (error) {
            // healthProbe 自己绝不抛；这里兜住"注入的替换实现"抛错的情况，
            // 一次探测异常不该让整轮 tick 崩掉（后台任务不能崩进程）。
            results.set(item.sourceRef, {
              state: 'fail',
              statusCode: null,
              durationMs: 0,
              detail: `探测异常：${error instanceof Error ? error.message : String(error)}`,
              at,
            });
          }
        }),
      );
    } finally {
      this.inFlight -= batch.length;
    }
    return results;
  }

  /** 容器索引：稳定服务标识 → 该服务名下的容器（多副本合并，与 Sprint 1 的服务身份同源）。 */
  private buildContainerIndex(live: ContainerListResult | null): Map<string, ContainerSummary[]> {
    const index = new Map<string, ContainerSummary[]>();
    for (const container of live?.items ?? []) {
      const ref = containerServiceRef(container);
      const list = index.get(ref);
      if (list) list.push(container);
      else index.set(ref, [container]);
    }
    return index;
  }

  /**
   * 一个服务绑定的容器。
   *
   * 优先按**稳定服务标识**匹配（`docker:<项目>/<服务>`，容器重建不换身份）；
   * 纯 serve / 手工服务退化为"服务视图里那个关联容器"。
   */
  private containersFor(
    sourceRef: string,
    views: readonly ServiceView[],
    index: Map<string, ContainerSummary[]>,
  ): ContainerSummary[] {
    const byRef = index.get(sourceRef);
    if (byRef && byRef.length > 0) return byRef;
    const view = views.find((item) => item.sourceRef === sourceRef);
    const linked = view?.container ?? null;
    if (!linked) return [];
    for (const list of index.values()) {
      const found = list.find((container) => container.id === linked.id || container.name === linked.name);
      if (found) return [found];
    }
    return [];
  }

  /** 把容器实况 + 探测结果组装成状态机需要的三维信号。 */
  private buildSignal(
    item: TrackedService,
    containers: readonly ContainerSummary[],
    probeResult: HealthProbeResult | null,
    previous: ServiceHealthState | null,
    at: string,
  ): HealthSignal {
    const container = this.containerDimension(containers);
    const dockerHealth = this.dockerHealthDimension(containers);
    let http: HealthDimensionState;
    const details: Partial<Record<HealthDimensionKey, string>> = {};
    if (container.detail) details.container = container.detail;
    if (dockerHealth.detail) details.dockerHealth = dockerHealth.detail;

    if (item.target === null) {
      // 规则 7：没有健康目标 → http 维固定 unknown，**不探测**，由容器维度决定 verdict。
      http = 'unknown';
      details.http = '未配置健康检查目标，不探测';
    } else if (probeResult) {
      http = probeResult.state === 'ok' ? 'ok' : 'fail';
      if (probeResult.detail) details.http = probeResult.detail;
    } else {
      // 被节流（或本轮没排上）：沿用上次结论，避免"没探测"被误读成"没信号"。
      const before = previous?.dimensions.http;
      http = before?.state ?? 'unknown';
      details.http = before?.detail ?? '尚未探测';
    }

    return {
      container: container.state,
      dockerHealth: dockerHealth.state,
      http,
      details,
      sourceRef: item.sourceRef,
      serviceId: item.serviceId,
      probedAt: probeResult ? at : null,
    };
  }

  /** 容器维度：绑定的容器**全部 running** 才算 ok；没有绑定容器 → unknown（不猜）。 */
  private containerDimension(containers: readonly ContainerSummary[]): { state: HealthDimensionState; detail: string | null } {
    if (containers.length === 0) return { state: 'unknown', detail: null };
    const offenders = containers.filter((container) => container.state !== 'running');
    if (offenders.length === 0) return { state: 'ok', detail: null };
    const detail = offenders
      .map((container) => `${container.name} ${CONTAINER_STATE_TEXT[container.state] ?? '状态异常'}（${container.state}）`)
      .join('；');
    return { state: 'fail', detail };
  }

  /**
   * docker health 维度：全部 `healthy`、或都没声明 HEALTHCHECK → ok；有 `unhealthy` → fail。
   *
   * `starting`（健康检查正在跑但还没通过）既不是 healthy 也不是 unhealthy，**记 unknown** ——
   * 把"还不知道"当成健康是自欺，当成失败会在每次容器启动时报假警。
   */
  private dockerHealthDimension(containers: readonly ContainerSummary[]): { state: HealthDimensionState; detail: string | null } {
    if (containers.length === 0) return { state: 'unknown', detail: null };
    const unhealthy = containers.filter((container) => container.health === 'unhealthy');
    if (unhealthy.length > 0) {
      return { state: 'fail', detail: unhealthy.map((container) => `${container.name}: unhealthy`).join('；') };
    }
    const starting = containers.filter((container) => container.health === 'starting');
    if (starting.length > 0) {
      return {
        state: 'unknown',
        detail: starting.map((container) => `${container.name}: 健康检查尚未通过（starting）`).join('；'),
      };
    }
    return { state: 'ok', detail: null };
  }

  /**
   * 丢掉"本次**成功读取**的服务快照里已经不存在的服务"的状态与标签。
   *
   * 调用方（`tick()`）只在服务列表**读取成功**时调用，且**空列表也调用**：
   * - 空列表 = 用户把服务全隐藏/全删了 → 必须连服务名（`labelsByRef`）一起清干净，
   *   只清状态会留下名字，等于把 hidden 服务的名字继续发给 viewer（P1 缺陷的根因）；
   * - 读取失败时不调用（见 `tick()`），否则数据源抖动会把连续失败计数抹掉、
   *   故障期间的告警随之消失。
   *
   * 另外按上限淘汰最久未评估的条目，保证内存有界。
   */
  private dropStaleStates(tracked: readonly TrackedService[]): void {
    const alive = new Set(tracked.map((item) => item.sourceRef));
    for (const ref of [...this.statesByRef.keys()]) {
      if (!alive.has(ref)) {
        this.statesByRef.delete(ref);
        this.labelsByRef.delete(ref);
      }
    }
    if (this.statesByRef.size <= MAX_TRACKED_SERVICES) return;
    const sorted = [...this.statesByRef.entries()].sort((a, b) => a[1].lastEvaluatedAt.localeCompare(b[1].lastEvaluatedAt));
    const overflow = this.statesByRef.size - MAX_TRACKED_SERVICES;
    for (let i = 0; i < overflow; i += 1) {
      const victim = sorted[i];
      if (!victim) break;
      this.statesByRef.delete(victim[0]);
      this.labelsByRef.delete(victim[0]);
    }
  }
}