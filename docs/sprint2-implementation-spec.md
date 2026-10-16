# Sprint 2 实现规格（冻结契约）— 轻量历史监控、健康与告警

> 对应 `docs/HomePort_2.0_Balanced_Development_Plan.md` §5（S2-01…S2-04）。
> **本文件是并行开发与验收的唯一真相来源**：签名、字段名、语义、错误码一律以此为准。
> 任何偏离都必须先改本文件，再改代码。
>
> 实现者请先读：`README.md`、`docs/static/01…09`、本文件。**不要**通读全部源码。

## 0. 全局约束（先读这一节）

1. **不引入任何新依赖**（前后端都不加包）。图表必须手写 SVG。
2. **不改动 Sprint 0/1 已有契约**：`GET /api/services` 的 `status.health` 仍是
   `ok | fail | skipped | unknown`（单次探测结果）；新的去抖判定走新端点。
   `ContainerStatsView`、`SystemSnapshot`、SSE 帧结构全部不变。
3. **默认不外发、不自动修复**：Sprint 2 没有任何出站通知通道（邮件/Webhook 是 Sprint 4），
   也不重启/停止任何容器。告警只产生站内事件 + 审计。
4. **缺测绝不写 0**：没有样本的时间桶**不写行**，图表按时间间隔断开。
   `samples < expected` 表示部分缺测，必须能显示出来（`partial: true`）。
5. **百分比与字节是两套指标键**，永不互相换算：`*.percent`（unit `percent`）与
   `*.used_bytes`（unit `bytes`）。API 层不做任何单位转换。
6. **纯函数优先**：聚合、状态机、去重、路径构建都写成纯函数（可单测、可注入时钟）。
   副作用只在仓储与 scheduler 里。
7. **数据库唯一约束是不变量，不是实现细节**（Sprint 1 验收教训）：见 §2.3 的部分唯一索引。
8. 所有新表进**迁移 v5**，追加在 `MIGRATIONS` 末尾，各自事务、记入 `schema_migrations`。
9. 所有时间戳：存 ISO 字符串（`nowIso()` 风格）或 unix 秒（`bucket_at`）。**桶时间一律 unix 秒**。
10. `process.env` 只能在 `server/src/config.ts` 读取（`envBoundary.test.ts` 守着）。

## 0.1 后台任务如何取服务/容器数据（对下文 §3.1 / §4.2 的修正）

**这两点原规格写错了，以此节为准：**

1. **不存在 `ServiceRegistrySnapshot` / `ServiceRegistryService.snapshot()`** ——
   那是起草时的臆造类型。真实可用的是：
   ```ts
   // server/src/modules/services/service.ts
   list(request: HostContextRequest, query?: ServiceListQuery, role?: ServiceRole): Promise<ServiceListResponse>
   // ServiceListResponse = { items: ServiceView[]; total; categories; discovery; generatedAt }
   // ServiceView 含 id/sourceRef/displayName/sourceType/visibility/healthTarget/healthPath/status/container/entries
   ```
   `list()` 内部会走 `sync()`（带发现缓存）与 `loadLive()`（容器 TTL 2s 缓存），
   所以**每 30s 一次调用不会新增 docker API 压力**。后台任务用
   `role: 'viewer'` —— **hidden 服务不采指标、不纳入监控**，否则历史接口会泄露
   用户刻意隐藏的服务名。

2. **后台任务没有 HTTP 请求**，而 `services.list()` / `containers.list()` 都需要
   `HostContextRequest`。已提供唯一实现，**两条线都必须用它，不要各写一个字面量**：
   ```ts
   import { backgroundHostRequest } from '../docker/backgroundContext.js';
   const hostRequest = backgroundHostRequest(config);   // { protocol:'http', hostname:'localhost', headers:{}, port:config.port }
   ```
   它与 `ServiceRegistryService.neutralRequest()` 的字面量一致（后者是私有方法），
   语义是"没有访问者，以配置为准"（`PORTAL_PUBLIC_HOST` → MagicDNS → tailnet → localhost）。
   **不要**伪造 `x-forwarded-*` 头。

3. **迁移 v5 只有三张表**（不是四张）：`metric_buckets`、`alert_rules`、`alert_events`。
   全部由指标线写进 `database.ts` 的 v5；**告警线不得改 `database.ts`**（只写业务逻辑与
   内置规则补齐 `ensureBuiltinRules()`）。

4. **既有 `server/tests/migrationV4.test.ts` 会被 v5 打破**（它硬编码了迁移链末端为 4，
   且"回落"步骤只删 `version = 4` 的记录、不删新表）。这是 `migrationV3.test.ts` 已经修过、
   而 v4 文件漏改的同类问题。**授权指标线做最小修复**：版本断言改成与
   `Math.max(...MIGRATIONS.map((m) => m.version))` 比对、回落步骤同时清掉 v5 的表与 `version = 5`
   的记录，并**保留它原有的全部 v4 断言**（不得为了让它变绿而删断言）。

## 1. 指标目录（S2-01 / S2-02 的骨架）

`metric key` 是**稳定标识**（进库、进 URL、进前端），改名等于改契约。

| key | label | unit | target 形态 | 数据源 |
| --- | --- | --- | --- | --- |
| `host.cpu.percent` | 宿主 CPU 使用率 | `percent` | `host` | `SystemProvider.snapshot().cpu.percent` |
| `host.memory.percent` | 宿主内存使用率 | `percent` | `host` | `snapshot().memory.percent` |
| `host.memory.used_bytes` | 宿主已用内存 | `bytes` | `host` | `snapshot().memory.usedBytes` |
| `host.disk.percent` | 磁盘使用率 | `percent` | `disk:<label>` | `snapshot().disks[].percent` |
| `host.disk.used_bytes` | 磁盘已用空间 | `bytes` | `disk:<label>` | `snapshot().disks[].usedBytes` |
| `container.cpu.percent` | 容器 CPU | `percent` | `container:<sourceRef>` | `containers.list({stats:true})` → `stats.cpuPercent` |
| `container.memory.used_bytes` | 容器内存（RSS 语义） | `bytes` | `container:<sourceRef>` | 同上 → `stats.memUsedBytes` |
| `service.health.up_ratio` | 服务健康采样占比 | `ratio` | `service:<sourceRef>` | 健康监视器的最新判定（§4） |

- `target` 一律用**稳定身份**，不用容器 ID（Sprint 1 的 `containerServiceRef()` /
  服务 `sourceRef`）。容器的 `target` 用 `containerServiceRef(container)`
  ——与 Sprint 1 的服务身份同源，重启容器不换 target。
- `service.health.up_ratio`：`verdict === 'healthy'` 记 1，其余（`down`/`degraded`）记 0，
  `unknown` **不计入样本**（既不记 1 也不记 0 —— 不知道就不能算健康）。
- **只采必要指标**：不加 GPU、不加网络、不加每核 CPU、不加全部容器
  （容器数上限 `PORTAL_METRICS_CONTAINER_LIMIT`，默认 10；超出的容器不采，
  在 catalog 里说明"只采关键容器"）。

## 1.1 存储与开销预算（"符合预算"的判据）

计划 §5 要求"历史数据量和 SQLite 大小被记录且符合预算"。**预算必须先定义，否则无法验收**，
所以这里给出可核对的数字（`storage()` 的 `budget` 字段就照这个实现）。

以"3 个磁盘挂载 + 10 个关键容器 + 7 个服务"的典型 NAS 部署为基准：

| 项 | 计算 | 结果 |
| --- | --- | --- |
| 每分钟行数 | host 3（cpu/内存%/内存字节）+ 磁盘 6（3 挂载 × %/字节）+ 容器 20（10 × 2）+ 服务 7 | **36 行/分钟** |
| minute 行数/天 | 36 × 1440 | **51,840 行/天** |
| minute 保留 24h 稳态 | 51,840 行（24h 窗口滚动，**不累积**） | 51,840 行 ≈ **\(10\sim12\) MB** |
| hour 行数/天 | 36 × 24 | **864 行/天** |
| hour 保留 30d 稳态 | 864 × 30 | 25,920 行 ≈ **\(5\sim6\) MB** |
| **稳态总量** | minute + hour | **≤ 32 MB**（含索引与空闲页） |
| 每行估算 | id(36)+resolution(6)+metric(22)+target(20)+label(12)+unit(7)+5×数(8)+created_at(24) ≈ 170 B + 索引开销 | ≈ 200 B/行 |

**验收判据**（写进报告与文档）：
1. 稳态库大小 ≤ **32 MB**，且 `GET /api/metrics/storage` 能报出行数与 `page_count × page_size`；
2. minute 行数**不随运行时长增长**（保留窗口滚动）——这条比"总量小"更能证明没有泄漏；
3. 单 tick 耗时：30 个 metric×target 的假数据源下 **< 50 ms**（测试断言）；
4. **每小时的库写次数 = 2**（分钟 flush + 小时 rollup），与 tick 数（120 次/小时）无关；
5. 采样不引入持续 CPU：`PORTAL_METRICS_SAMPLE_INTERVAL_SEC=30` 时，
   采集本身是 `SystemProvider.snapshot()`（原本就被 SSE 用着）+ 一次容器列表缓存读，
   **不新增 docker API 调用频率**（复用 TTL 2s 缓存）。

> 若实际行数偏离基准量级（例如服务数 20、容器上限调到 100），预算按比例修正，
> 但**第 2、4、5 条判据与规模无关，任何配置下都必须成立**。

## 2. 数据模型（迁移 v5）

### 2.1 `metric_buckets`

```sql
CREATE TABLE metric_buckets (
  id           TEXT PRIMARY KEY,
  resolution   TEXT NOT NULL,          -- 'minute' | 'hour'
  metric       TEXT NOT NULL,          -- §1 的 key
  target       TEXT NOT NULL,          -- §1 的 target 形态
  target_label TEXT NOT NULL,          -- 展示用（'宿主' / 'C:' / 'sisi-calendar'），随桶更新
  unit         TEXT NOT NULL,          -- 'percent' | 'bytes' | 'ratio'
  bucket_at    INTEGER NOT NULL,       -- 桶起点 unix 秒（对齐到 resolution）
  value        REAL NOT NULL,          -- 桶内均值（ratio 即"健康采样占比"）
  min_value    REAL NOT NULL,
  max_value    REAL NOT NULL,
  samples      INTEGER NOT NULL,       -- 实际参与聚合的样本数
  expected     INTEGER NOT NULL,       -- 该桶应有的样本数
  created_at   TEXT NOT NULL,
  UNIQUE (resolution, metric, target, bucket_at)
);
CREATE INDEX idx_metric_buckets_series ON metric_buckets (resolution, metric, target, bucket_at);
CREATE INDEX idx_metric_buckets_retention ON metric_buckets (resolution, bucket_at);
```

语义（**这些是契约，测试要逐条锁**）：

- `bucket_at = floor(now / 60) * 60`（minute）或 `floor(now / 3600) * 3600`（hour）。
- `value/min/max` = 桶内样本的 **mean/min/max**；`ratio` 同样是 mean（= 健康占比）。
- minute 桶的 `samples` = 该分钟内成功的原始 tick 数；`expected = max(1, round(60 / intervalSec))`。
- hour 桶的 `samples` = 该小时内**存在的 minute 桶数**；`expected = 60`。
- **缺测 = 没有行**。整桶无样本时**不写行**，也绝不写 `value = 0`。
- `samples < expected` → 部分缺测（`partial`），图表与接口都要能表达。
- 一个桶只写一次（`INSERT ... ON CONFLICT(resolution,metric,target,bucket_at) DO UPDATE`，
  用于同一分钟内多次刷新的幂等重写）。

### 2.2 保留清理

| resolution | 默认保留 | 键 |
| --- | --- | --- |
| `minute` | 24 小时 | `PORTAL_METRICS_RETENTION_MINUTE_HOURS` |
| `hour` | 30 天 | `PORTAL_METRICS_RETENTION_HOUR_DAYS` |

启动时清理一次，之后**每次小时滚动**再清理。清理只 `DELETE` 过期行（不做 VACUUM）。

### 2.3 `alert_rules`

```sql
CREATE TABLE alert_rules (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,       -- 'disk_percent'|'memory_percent'|'container_exit'|'service_health'
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 0,   -- 内置规则默认禁用（计划要求）
  threshold       REAL,                -- 百分比阈值 / 连续失败次数
  duration_sec    INTEGER NOT NULL DEFAULT 0,   -- 需持续多久
  target          TEXT,                -- NULL = 适用于全部目标；'disk:C:' / 'service:<sourceRef>'
  silence_sec     INTEGER NOT NULL DEFAULT 3600,
  notify_recovery INTEGER NOT NULL DEFAULT 1,
  severity        TEXT NOT NULL DEFAULT 'warning',  -- 'warning' | 'critical'
  builtin         INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
```

内置四条（`builtin = 1`，`enabled = 0`，可在网页开关/改阈值，**不可删除**）：

| kind | name | threshold | duration_sec | silence_sec | severity |
| --- | --- | --- | --- | --- | --- |
| `disk_percent` | 磁盘使用率过高 | `85` | `600` | `3600` | `warning` |
| `memory_percent` | 内存使用率过高 | `90` | `300` | `3600` | `warning` |
| `container_exit` | 容器异常退出 | `0`（非 0 退出码即触发） | `0` | `3600` | `critical` |
| `service_health` | 服务连续探测失败 | `3`（连续失败次数） | `0` | `3600` | `critical` |

### 2.4 `alert_events`（**episode 模型** + 部分唯一索引）

一个 `(rule_id, target)` 的"一次故障"= 一行；恢复写 `resolved_at`，
静默期内再次触发**重开同一行**（`reopen_count++`）而不是插新行 —— 这就是
"一小时内不重复刷屏"的落地方式。

```sql
CREATE TABLE alert_events (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  rule_name       TEXT NOT NULL,
  target          TEXT NOT NULL,
  target_label    TEXT NOT NULL,
  severity        TEXT NOT NULL,
  value           REAL,                -- 触发时的取值
  threshold       REAL,
  unit            TEXT,
  message         TEXT NOT NULL,
  started_at      TEXT NOT NULL,       -- 条件首次成立（可能早于 fired_at：duration 窗口）
  fired_at        TEXT NOT NULL,       -- 真正判定为告警
  resolved_at     TEXT,                -- NULL = 仍在告警
  reopen_count    INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  created_at      TEXT NOT NULL
);
-- 不变量：同一规则同一目标最多只有一行未恢复（Sprint 1 的教训：把它放进约束，而不是靠调用方自觉）
CREATE UNIQUE INDEX idx_alert_events_open ON alert_events (rule_id, target) WHERE resolved_at IS NULL;
CREATE INDEX idx_alert_events_recent ON alert_events (fired_at DESC);
```

**重开规则**：`resolved_at` 非空的行，若在 `fired_at`（上次触发）后 `silence_sec` 内
条件再次成立 → 重开该行（`resolved_at = NULL`、`reopen_count + 1`、
`acknowledged_at/by` 清空、`started_at/fired_at` 更新为本次）；超过静默期 → 插新行。
重开与新建都要写审计（`alert.reopened` / `alert.fired`），但**只有新建**算"再次通知"。

### 2.5 审计动作名（进 `audit_log`）

`alert.rule_updated`、`alert.fired`、`alert.reopened`、`alert.resolved`、`alert.acknowledged`。
审计 `detail` 只放非敏感字段（rule id/kind/target/value/threshold），不放任何凭据。

## 3. 后台单例与调度（S2-01）

`server/src/modules/metrics/scheduler.ts`

```ts
export interface SchedulerDeps {
  health: { tick(now: number): Promise<HealthTickResult> };
  metrics: { tick(now: number): Promise<MetricsTickResult> };
  alerts: { tick(now: number): Promise<AlertTickResult> };
  logger: Logger;
  clock?: () => number;                 // 默认 Date.now
  intervalMs?: () => number;            // 默认读 config（见 §6），每次排期时求值
}
export class BackgroundScheduler {
  start(): void;                        // 立即跑一次 tickOnce，然后 setInterval；timer.unref()
  stop(): void;                         // 清定时器（app.close() 必须调用）
  async tickOnce(now?: number): Promise<TickSummary>;   // 单飞：重入直接返回 { skipped: true }
  readonly running: boolean;
  lastSummary(): TickSummary | null;
}
export interface TickSummary {
  at: string; durationMs: number; skipped: boolean;
  health: HealthTickResult; metrics: MetricsTickResult; alerts: AlertTickResult;
  error: string | null;                 // 任一步失败只记在这里，不抛出（后台任务不能崩进程）
}
```

- **顺序固定**：`health.tick()` → `metrics.tick()` → `alerts.tick()`。
  指标里的 `service.health.up_ratio` 必须用**本 tick 刚更新**的健康判定；
  告警评估必须用**本 tick 刚写入**的样本。
- **单飞**：上一 tick 未结束时新的 tick 直接跳过（`skipped: true`），不排队、不并发。
- **失败隔离**：任一步抛错 → 记 `TickSummary.error` + `logger.warn`，
  本次剩下的步骤仍要尝试（`try/catch` 各自包住）。采集失败表现为**该分钟没有样本**
  → 落库时就是缺测（gap），不是 0。
- `unref()` 必需：`buildApp({ backgroundJobs: false })` 的测试进程不能被定时器吊住。
- **不为每个前端会话采集**：全进程只有 `app.ts` 创建的一个 `BackgroundScheduler`。
  SSE 推送仍走原有 `SystemService`，**不读也不需要** `metric_buckets`。

### 3.1 `MetricsSampler`

```ts
export interface MetricsDeps {
  db: Database.Database;
  config: PortalConfig;
  logger: Logger;
  system: { snapshot(): Promise<SystemSnapshot> };
  containers: { list(query: ContainerListQuery, request: HostContextRequest): Promise<ContainerListResult> };
  registry: { list(request: HostContextRequest, query?: ServiceListQuery, role?: ServiceRole): Promise<ServiceListResponse> };   // 传 services 实例即可；见 §0.1（没有 snapshot()）
  clock?: () => number;
  intervalSec?: () => number;                                    // 默认读 config
}
export class MetricsSampler {
  tick(now: number): Promise<MetricsTickResult>;
  flushPending(now: number): BucketWriteResult;    // 把"已结束的分钟"落库（纯 DB 写）
  rollupHours(now: number): BucketWriteResult;     // 从 minute 行聚合出缺失的整点 hour 行
  prune(now: number): number;                      // 保留清理，返回删除行数
  storage(): MetricStorageView;
}
export interface MetricsTickResult {
  at: string; collected: number; samplesWritten: number; bucketsFlushed: number;
  hoursRolledUp: number; pruned: number; gaps: number; errors: string[];
}
```

- **内存累积 + 分钟落库**：tick 只把样本累加进当前分钟的累加器
  （`sum/count/min/max`，按 `metric|target` 分桶，**不写库**）；
  tick 开始时先把**已经结束**的分钟（`bucket_at < 当前分钟起点`）批量写库并清空。

  > **勘误（本规格早期版本在这里算错了）**：原文写"一小时的 tick 只产生 2 次批量写"，
  > 那是错的 —— 漏掉了 **flush 会在每个分钟边界发生**，而不是每小时一次。
  > 真实数字是 **61 次/小时 = 60 次 flush + 1 次整点 rollup**（30s 采样间隔下）。
  > 实现按上面的机制原文走（重启数据损失上界 = **1 个采样间隔**），
  > 而把"符合预算"的判据换成下面三条**机器可证**的形式：
  > 1. **写事务数与 tick 密度无关** —— 30s 与 5s 两种间隔跑同样时长，写事务数完全相同
  >    （1861），因为累积在内存、只有"分钟结束"才落库；
  > 2. **整点那一 tick 恰好 2 次批量写**（flush + rollup），这是个可精确断言的锚点；
  > 3. **与前端会话数无关** —— 采样是后台单例，一个浏览器都没连时照样采
  >    （`server/tests/schedulerIntegration.test.ts` 用零 SSE/HTTP 客户端验证）。
  >
  > 被否决的替代方案：攒到整点才 flush 能做到字面上的"2 次/小时"，代价是**当前小时只存在于
  > 内存**，重启最多丢 59 分钟、且 1h 视图在整点前恒为空 —— 与"重启后历史保留"和
  > "最近 24h 每分钟 1 条"直接冲突，故不采用。
  >
  > 真正要守的核心不变量是**"不产生每 tick 一次的库写"**（这才是"采样不引起高 CPU"的含义），
  > 上面第 1 条正是它的可证形式。
- **hour 滚动从 DB 聚合**（不在内存累积）：`rollupHours` 找出 `[now-?, now)` 内
  **已完整结束**、minute 行存在但 hour 行缺失的整点，`SELECT ... GROUP BY bucket_at` 聚合写入。
  因此重启后能补上停机期间的整点（只要有 minute 行）；没有 minute 行的整点**不写行**（gap）。
- `gaps`：本次 flush 的分钟桶里 `samples < expected` 的桶数（含"整分钟一个样本都没有"的
  情况 —— 后者不写行，但要计入 `gaps` 并在日志里提一句）。
- `storage()` 读 `PRAGMA page_count/page_size/freelist_count` + 行数 + 最老/最新时间 +
  保留配置 + 预算估算（`estimatedBytesPerDay`：按当前 minute 行数与保留窗口线性外推，
  `note` 里写明这是估算）。

### 3.2 历史查询

```ts
// server/src/modules/metrics/history.ts（纯函数 + 一次 SELECT）
export function resolutionForRange(range: MetricRange): 'minute' | 'hour';
export function rangeWindow(range: MetricRange, now: number): { from: number; to: number };
export function buildHistoryView(input: {...}): MetricHistoryView;   // 组装缺口统计/summary
```

| range | resolution | from |
| --- | --- | --- |
| `1h` | `minute` | now - 3600 |
| `24h` | `minute` | now - 86400 |
| `7d` | `hour` | now - 7*86400 |
| `30d` | `hour` | now - 30*86400 |

- 查询命中 `idx_metric_buckets_series`，`WHERE resolution=? AND metric=? AND target=? AND bucket_at >= ? AND bucket_at <= ?`。
- `gaps.missingBuckets` = 窗口内应有桶数 − 实际行数（应有桶数 = `window / 60` 或 `/ 3600`，向下取整）；
  `partialBuckets` = 实际行里 `samples < expected` 的数量。
- `summary` = 对**有值的桶**做 min/max/avg + 最新值与时间；窗口内一行都没有 → `count: 0`，
  其余字段为 `null`（**不要**用 0 冒充）。

## 4. 健康监测（S2-03）

`server/src/modules/health/`

### 4.1 状态机 `state.ts`（纯函数，无 I/O）

三个**互相独立**的判定维度，各自计数，任一维失败都可能推动整体判定：

| 维度 | 合格条件 | 不合格条件 |
| --- | --- | --- |
| `container` | 绑定的容器全部 `running` | 有容器 `exited`/`dead`/`restarting` |
| `dockerHealth` | 全部 `healthy`，或都没声明 HEALTHCHECK | 有容器 `unhealthy` |
| `http` | 最近一次 HTTP 探测成功 | 最近一次探测失败/超时 |

```ts
export type HealthDimensionState = 'ok' | 'fail' | 'unknown';
export type HealthVerdict = 'healthy' | 'degraded' | 'down' | 'unknown';
export interface HealthDimension { state: HealthDimensionState; consecutiveFailures: number; detail: string | null; }
export interface HealthSignal { container: HealthDimensionState; dockerHealth: HealthDimensionState; http: HealthDimensionState; details?: Partial<Record<'container'|'dockerHealth'|'http', string>>; }
export interface ServiceHealthState {
  sourceRef: string; serviceId: string; verdict: HealthVerdict;
  dimensions: { container: HealthDimension; dockerHealth: HealthDimension; http: HealthDimension };
  consecutiveFailures: number; consecutiveSuccesses: number;
  changedAt: string; lastEvaluatedAt: string; lastProbeAt: string | null; reasons: string[];
}
export function evaluateHealth(previous: ServiceHealthState | null, signal: HealthSignal, options: { failThreshold: number; okThreshold: number; at: number }): ServiceHealthState;
```

判定规则（**必须逐条测**）：

1. `failThreshold`（默认 3）次**连续**失败才把 verdict 判为 `down`
   —— 单次失败是 `degraded`（短暂抖动不告警）。
   "失败"= 三维中**至少一维** `fail`。
2. `okThreshold`（默认 2）次**连续全好**才回到 `healthy`（恢复去抖）。
3. `unknown` 维**不参与**成败判定（没信号 ≠ 坏）。三维全 `unknown` → verdict `unknown`。
4. 维度计数独立：HTTP 连续失败 2 次而容器正常时，`http.consecutiveFailures = 2`、
   `container.consecutiveFailures = 0`，verdict 仍是 `degraded`。
5. 任一维状态变化 → 计数归零重算；`changedAt` 只在 **verdict 变化**时更新。
6. `reasons` 用人话写清是哪一维、连续几次、以及证据（如 `容器 sisi-calendar 已退出（exited）`、
   `HTTP 探测失败 2/3 次：连接超时`）。**不要**在证据不足时猜原因。
7. 没有 `healthTarget` 的服务：`http` 维固定 `unknown`（**不探测**），
   由容器维度决定 verdict（与 Sprint 1 的"默认 skipped 不探测"一致）。

### 4.2 监视器 `monitor.ts`

```ts
export interface HealthMonitorDeps {
  config: PortalConfig; logger: Logger;
  registry: { list(request: HostContextRequest, query?: ServiceListQuery, role?: ServiceRole): Promise<ServiceListResponse> };   // 见 §0.1
  containers: { list(query: ContainerListQuery, request: HostContextRequest): Promise<ContainerListResult> };
  probe: (target: string, options?: { timeoutMs?: number }) => Promise<HealthProbeResult>;  // 复用 Sprint 1 healthProbe
  clock?: () => number;
  intervalSec?: () => number;        // 默认读 config；0 = 关闭自动探测
  concurrency?: () => number;        // 默认读 config
}
export class HealthMonitor {
  tick(now: number): Promise<HealthTickResult>;
  states(): ServiceHealthState[];
  state(sourceRef: string): ServiceHealthState | null;
  probeStats(): { intervalSec: number; concurrency: number; inFlight: number; lastRunAt: string | null; probedThisTick: number; skippedForConcurrency: number };
}
export interface HealthTickResult { at: string; evaluated: number; probed: number; skippedForConcurrency: number; failures: number; }
```

- **容器维度与 docker health 不额外发请求**：用 `containers.list({ all: true, stats: false })`
  的缓存结果（TTL 2s），每 tick 一次。
- **HTTP 探测有独立节流**：每个服务距上次探测不足 `intervalSec` 就不探（默认 300s）。
- **全局并发上限**（`PORTAL_HEALTH_PROBE_CONCURRENCY`，默认 4）：本轮最多同时
  `concurrency` 个在飞探测；达到上限的服务**推迟到下一 tick**（记入 `skippedForConcurrency`），
  不排队、不无限等待。顺序按 `sourceRef` 稳定排序 → 可测。
- 探测失败**不能**清掉服务配置或已保存状态（Sprint 1 的纪律）。
- 探测仍走 Sprint 1 的 SSRF 防护（拒绝凭据 URL、通配、云元数据、Docker API 端口、unix socket），
  超时 3s、响应体 16KB 上限 —— **不要**绕过 `healthProbe.ts`。

## 5. 告警引擎（S2-04）

`server/src/modules/alerts/`

### 5.1 规则 `rules.ts`

```ts
export const ALERT_KINDS = ['disk_percent', 'memory_percent', 'container_exit', 'service_health'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const BUILTIN_ALERT_RULES: readonly BuiltinAlertRule[];   // §2.3 的四条
export function mergeBuiltinRules(rows: AlertRuleRow[], now: string): AlertRuleRow[];  // 补齐缺失的内置规则（幂等）
export function validateRulePatch(kind: AlertKind, patch: AlertRulePatch): { ok: true; value: ... } | { ok: false; reason: string };
```

阈值校验（越界一律 `VALIDATION_FAILED`，不静默截断）：
`disk_percent`/`memory_percent` 的 `threshold ∈ (0, 100]`；`duration_sec ∈ [0, 86400]`；
`silence_sec ∈ [60, 86400*7]`；`service_health` 的 `threshold ∈ [1, 10]` 且必须整数；
`container_exit` 的 `threshold` 必须为 `0`（非 0 退出码即触发，不设百分比）。

### 5.2 引擎 `engine.ts`

```ts
export interface AlertEngineDeps {
  db: Database.Database; config: PortalConfig; logger: Logger;
  audit: (action: string, detail: Record<string, unknown>) => void;   // 复用 ctx.audit 形态
  clock?: () => number;
}
export interface AlertSnapshot {
  at: number;
  host: { cpuPercent: number | null; memoryPercent: number | null; disks: Array<{ label: string; percent: number | null }> };
  containers: Array<{ sourceRef: string; label: string; containerId: string; state: string; exitCode: number | null; startedAt: string | null }>;
  services: Array<{ sourceRef: string; serviceId: string; label: string; verdict: HealthVerdict; consecutiveFailures: number }>;
}
export class AlertEngine {
  tick(now: number, snapshot: AlertSnapshot): Promise<AlertTickResult>;
  // 内部：evaluateRule(kind, snapshot, now) → 候选事件；再经 silence/episode 规则落库
}
export interface AlertTickResult { at: string; evaluated: number; opened: number; reopened: number; resolved: number; suppressed: number; }
```

各 kind 的触发条件（**逐条测**）：

| kind | 条件 | 目标 | value/unit |
| --- | --- | --- | --- |
| `disk_percent` | 某磁盘 `percent > threshold` 持续 `duration_sec` | `disk:<label>`（或规则 `target` 指定） | 当前百分比 / `percent` |
| `memory_percent` | 宿主内存 `percent > threshold` 持续 `duration_sec` | `host` | 百分比 / `percent` |
| `container_exit` | 容器 `state` 是异常终止（`exited` 且 `exitCode !== 0`，或 `dead`） | `container:<sourceRef>` | exitCode / `exit_code` |
| `service_health` | 服务的 `consecutiveFailures >= threshold`（由 §4 的状态机给，不再自己数） | `service:<sourceRef>` | 连续失败次数 / `count` |

- **duration 计时在内存**（`pendingSince` map），重启后重新计时 —— 这是可接受的
  （并在文档里写明）；但**未恢复的告警不能因重启而重复通知**，靠 §2.4 的部分唯一索引 +
  "存在未恢复行即不发新事件"实现（**这条必须有测试**：预置一行未恢复的 firing，
  `tick()` 不得插入新行）。
- `container_exit` 的特殊性：容器会一直处于 `exited`，所以**一次异常退出只告警一次**：
  同一 `(rule, target)` 的未恢复 episode 已存在就不再触发；恢复条件 =
  该 sourceRef 的容器重新 `running`。
- `suppressed` 计数 = 命中静默期被压掉的触发次数（要能在 `summary`/日志里看到，
  否则"没有告警"到底是被压了还是条件没成立就说不清）。
- 规则 `enabled = 0` 时**完全不评估**（默认四条内置规则即"装了但不吵"）。
- 引擎不做任何出站调用。

### 5.3 业务出口 `service.ts`

```ts
export class AlertsService {
  ensureBuiltinRules(at?: string): number;   // 补齐缺失的内置规则（幂等，返回插入条数）；装配时调一次
  rules(): AlertRuleView[];
  updateRule(id: string, patch: AlertRulePatch, actor: string): AlertRuleView;   // 非法 → VALIDATION_FAILED
  events(query: { state?: 'all'|'open'|'resolved'; limit?: number }): { items: AlertEventView[]; total: number; counts: {...} };
  acknowledge(id: string, actor: string): AlertEventView;    // 已恢复的事件也能确认；不存在 → NOT_FOUND
  summary(): AlertSummaryView;
}
```
- `summary().open` = 未恢复事件数；`unacknowledged` = 未恢复且未确认数；
  `top` 按 severity 与 `fired_at` 排序取前 5；`evaluatedAt` = 上次 tick 时间。
- 所有写操作（`updateRule` / `acknowledge`）走审计（§2.5）。

## 6. 新增配置项（settings，全部 `effect: 'live'`）

加进 `server/src/config.ts`（env 解析 + 类型 + 默认值 + 范围校验）**与**
`server/src/modules/settings/registry.ts`（`SettingDefinition`，分组 `metrics` / `health`）。
`live` 级：依赖方每次调用时读 `config`（`intervalMs()` / `intervalSec()` 就是为此设计的闭包）。
**不要**加 `restart` 级键。

| 键 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` | `30` | 5–3600 | 后台采样 tick 间隔（同时是 minute 桶的期望样本数基准） |
| `PORTAL_METRICS_RETENTION_MINUTE_HOURS` | `24` | 1–168 | minute 桶保留 |
| `PORTAL_METRICS_RETENTION_HOUR_DAYS` | `30` | 1–3650 | hour 桶保留 |
| `PORTAL_METRICS_CONTAINER_LIMIT` | `10` | 0–100 | 采集容器的数量上限（0 = 不采容器） |
| `PORTAL_HEALTH_PROBE_INTERVAL_SEC` | `300` | 0–86400 | 自动 HTTP 探测间隔（**0 = 关闭自动探测**，只在手动探测时更新） |
| `PORTAL_HEALTH_PROBE_CONCURRENCY` | `4` | 1–32 | 全局在飞探测上限 |

**`PortalConfig` 的 TS 形状（照既有嵌套命名空间约定，勿改成扁平字段）**：

```ts
export interface PortalConfig {
  // …既有字段…
  metrics: {
    sampleIntervalSec: number;      // PORTAL_METRICS_SAMPLE_INTERVAL_SEC
    minuteRetentionHours: number;   // PORTAL_METRICS_RETENTION_MINUTE_HOURS
    hourRetentionDays: number;      // PORTAL_METRICS_RETENTION_HOUR_DAYS
    containerLimit: number;         // PORTAL_METRICS_CONTAINER_LIMIT
  };
  health: {
    probeIntervalSec: number;       // PORTAL_HEALTH_PROBE_INTERVAL_SEC
    probeConcurrency: number;       // PORTAL_HEALTH_PROBE_CONCURRENCY
  };
}
```

非法值：`config.ts` 里启动即报错（与既有 `parseTrustProxy` 同风格）；
运行时改值走 settings（`validateSettingValue` 同一套范围）。
`loadConfig(overrides)` 的 `overrides` 是 `Partial<PortalConfig>`，**嵌套对象要整体覆盖**，
测试里传 `{ metrics: { ...loadConfig().metrics, sampleIntervalSec: 1 } }` 这类写法时注意别丢字段。

## 7. HTTP 契约

新路由文件：`server/src/api/metrics.ts`（`registerMetricsRoutes`）、
`server/src/api/alerts.ts`（`registerAlertRoutes`）。
`PROTECTED_PREFIXES` 增加 `/api/metrics`、`/api/alerts`、`/api/health/monitor`
（→ 统一 `requireRole('viewer')` + CSRF 钩子；写操作再 `assertAdmin`）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/metrics/catalog` | viewer | §1 目录 + 可用 target + range 表 + sampler 状态 |
| `GET` | `/api/metrics/history` | viewer | `?metric=&target=&range=` |
| `GET` | `/api/metrics/storage` | viewer | 行数/大小/保留/预算 + 最近一次 tick 摘要 |
| `GET` | `/api/health/monitor` | viewer | §4 逐服务三维状态 + probe 统计 |
| `GET` | `/api/alerts/rules` | viewer | 四条内置 + 当前配置 |
| `PATCH` | `/api/alerts/rules/:id` | **admin** | 部分更新（enabled/threshold/durationSec/silenceSec/notifyRecovery/target） |
| `GET` | `/api/alerts/events` | viewer | `?state=all\|open\|resolved&limit=1..200`（默认 50） |
| `POST` | `/api/alerts/events/:id/ack` | **admin** | 确认（CSRF） |
| `GET` | `/api/alerts/summary` | viewer | 徽标用计数 |

响应统一**无信封**（与既有接口一致），201/200 按既有惯例；错误码用既有
`VALIDATION_FAILED`(400) / `NOT_FOUND`(404) / `FORBIDDEN`(403)。

**两个列表/聚合端点的外层形状（补冻结 —— 起草时漏了，导致前端只能返回 `unknown` 再写归一化函数，
而归一化会把"服务端违约"变成静默兼容，必须避免）**：

```jsonc
// GET /api/alerts/rules → 200（列表端点与 /api/services、/api/alerts/events 保持一致）
{ "items": [ /* AlertRuleView[]，见 §5.3 与下面字段 */ ] }

// AlertRuleView 字段（与 alert_rules 表一一对应，不含内部列）
{ "id": "rule-disk-percent", "kind": "disk_percent", "name": "磁盘使用率过高",
  "description": "…", "enabled": false, "threshold": 85, "durationSec": 600,
  "target": null, "silenceSec": 3600, "notifyRecovery": true,
  "severity": "warning", "builtin": true, "updatedAt": "…" }

// GET /api/alerts/summary → 200（聚合对象，不是列表，直接返回对象本身）
{ "open": 2, "unacknowledged": 1, "suppressed": 3,
  "bySeverity": { "warning": 1, "critical": 1 },
  "top": [ /* 最多 5 条：{ id, ruleName, targetLabel, severity, firedAt } */ ],
  "evaluatedAt": "…" }
```

服务层 `AlertsService.rules()` 仍返回**裸数组**（`AlertRuleView[]`），
由路由包成 `{ items }` —— 层次分工，不要把包装混进服务层。

```jsonc
// GET /api/metrics/history?metric=host.cpu.percent&target=host&range=24h
{
  "metric": "host.cpu.percent", "label": "宿主 CPU 使用率", "unit": "percent",
  "target": "host", "targetLabel": "宿主",
  "range": "24h", "resolution": "minute",
  "from": "2026-10-15T10:00:00.000Z", "to": "2026-10-16T10:00:00.000Z",
  "sampling": { "intervalSec": 30, "aggregate": "mean", "expectedPerBucket": 2,
                "note": "30s 采样 → 每分钟 1 条；缺测处断开，不补 0" },
  "source": { "available": true, "mode": "host-proc", "detail": null },
  "points": [{ "at": "2026-10-15T10:00:00.000Z", "value": 12.4, "min": 10.1, "max": 22.0,
               "samples": 2, "expected": 2, "partial": false }],
  "gaps": { "missingBuckets": 3, "partialBuckets": 5 },
  "summary": { "count": 1440, "min": 3.1, "max": 91.2, "avg": 22.7, "latest": 12.4, "latestAt": "..." }
}
```

```jsonc
// GET /api/alerts/events?state=open
{
  "items": [{
    "id": "alert-...", "ruleId": "rule-disk-percent", "kind": "disk_percent",
    "ruleName": "磁盘使用率过高", "target": "disk:C:", "targetLabel": "C:",
    "severity": "warning", "state": "open", "value": 91.2, "threshold": 85, "unit": "percent",
    "message": "磁盘 C: 使用率 91.2%（阈值 85%，已持续 12 分钟）",
    "startedAt": "...", "firedAt": "...", "resolvedAt": null, "reopenCount": 0,
    "acknowledgedAt": null, "acknowledgedBy": null
  }],
  "total": 1, "counts": { "open": 1, "resolved": 4, "unacknowledged": 1 }
}
```

## 8. 前端契约

新增（`web/src/`）：`api/metrics.ts`、`api/alerts.ts`、`hooks/useMetricsHistory.ts`、
`hooks/useAlertSummary.ts`、`components/MetricsChart.tsx`、`components/MetricPicker.tsx`、
`components/AlertEventList.tsx`、`components/AlertRuleForm.tsx`、
`pages/HistoryPage.tsx`（`/history`）、`pages/AlertsPage.tsx`（`/alerts`）。

- 类型**手写镜像** `server/src/modules/metrics/types.ts` /
  `modules/alerts/types.ts`（沿用 Sprint 1 的做法，前端不 import 后端代码）。
- **图表手写 SVG，零依赖**：折线 + 面积、Y 轴 3–5 个刻度带**单位**、
  X 轴按 range 给人类可读刻度；**缺测处断开**（`bucket_at` 间距 > resolution 就断线，
  不允许跨缺口连线）；`partial: true` 的桶用虚线段或更浅的颜色；
  悬停显示时间/值/样本数（`3/2 样本` 这种要能看出部分缺测）。
- **必须标注**：单位、数据源（`source.mode` + detail）、采样方式（`sampling.note`）、
  窗口内缺测桶数量。这四项是计划 S2-02 的原文要求，缺一不可。
- **百分比与字节分开呈现**：Y 轴标签带 `%` 或 `B/KB/MB/GB`，切换指标时整体重取，
  绝不在前端把 percent 换算成 bytes。
- 空态（`count === 0`）必须可读：`还没有历史数据` + 一句"后台采样每 N 秒一次，
  重启 HomePort 后历史会保留；缺测处会断开"——**不要**画一条 0 的平线。
- `/alerts`：viewer 只看事件列表 + 计数；admin 追加规则表单（开关/阈值/静默/恢复通知）
  与"确认"按钮。规则表单复用既有 `ServiceForm` 的字段规范与校验展示风格。
- 导航：`历史`（`/history`）、`告警`（`/alerts`，带未确认计数徽标）。
  导航项对 viewer 也可见（只读）。更新 `web/tests/*nav*` 与 E2E 的导航断言。
- 权限不足时前端不显示管理入口（与 Sprint 1 一致），但后端仍独立拒绝。

## 9. 装配与生命周期

`server/src/app.ts`：

```ts
const metrics = new MetricsSampler({ db, config, logger, system, containers, registry: services });
const health  = new HealthMonitor({ config, logger, registry: services, containers, probe: runHealthProbe });
const alerts  = new AlertEngine({ db, config, logger, audit: ctx.audit });
const alertsService = new AlertsService({ db, audit: ctx.audit });
alertsService.ensureBuiltinRules();          // 幂等补齐四条内置规则（默认 enabled = 0）
const scheduler = new BackgroundScheduler({ health, metrics, alerts, logger });
if (options.backgroundJobs === true) scheduler.start();
// close(): 先 scheduler.stop()，再清理会话/审计定时器与 db.close()
```
移植注意事项（照 `app.ts` 既有 `cleanupTimer` 的写法）：
- `setInterval(...)` 后必须 `.unref()`（否则测试进程会被定时器吊住）；
- `close()` 里 **`scheduler.stop()` 必须在 `db.close()` 之前**，否则 tick 可能在库已关闭后写库；
- `runHealthProbe` 从 `modules/services/healthProbe.js` import（Sprint 1 已有，别复制一份探测逻辑）；
- 后台取数据一律用 `backgroundHostRequest(config)`（§0.1），不要另造请求字面量。

- `BuildAppOptions` 新增 **`backgroundJobs?: boolean`（默认 `false`）**；
  `server/src/index.ts` 显式 `backgroundJobs: true`。
  **理由写进代码注释与文档**：`buildApp` 被大量测试 `inject` 复用，默认开定时器
  会让测试变慢且相互干扰；生产入口只有一个（`index.ts`），由它开启。
- `AppHandle` 新增 `metrics`、`health`、`alerts`、`scheduler`（测试要直接调 `scheduler.tickOnce()`）。
- `close()` 必须 `scheduler.stop()`，否则测试进程被定时器吊住。

## 10. 测试要求（不接受"跑通就行"）

**必须覆盖的用例**（每一条都要有明确断言，不是 smoke）：

| 文件 | 必须覆盖 |
| --- | --- |
| `server/tests/metricsBuckets.test.ts` | 分钟聚合 mean/min/max/samples；**整分钟无样本不写行**；`samples<expected` 标 partial；幂等重写同一桶；小时滚动**从 minute 行**聚合（含"停机跨越 3 小时→启动后补齐 2 个整点，缺 minute 的整点不写行"）；保留清理按两个 resolution 分别生效且删对行 |
| `server/tests/metricsSampler.test.ts` | **一昼夜确定性仿真**（注入时钟，30s 一 tick 跑 30h）：①24h 窗口内每个 metric×target 恰好 ~1440 条 minute 桶；②30d 窗口内 ~720 条 hour 桶（用 **721 tick 的 30 天整点仿真**真跑出来，不靠外推；30h 仿真只用于 24h=1440 条 minute 桶）；③**写事务数与 tick 密度无关**（30s 与 5s 两种间隔的写事务数完全相同 = 1861；且整点那一 tick 恰好 2 次批量写：flush + rollup）；④采集中断 10 分钟 → 该段**无行**（gap）而不是 0；⑤单飞：重入 tick 返回 `skipped`；⑥单 tick 耗时上界断言（例如 < 50ms，用假数据源）；⑦重启（新建 sampler 复用同一 db）后历史仍在、小时桶能补 |
| `server/tests/metricsHistory.test.ts` | range→resolution 映射；`1h/24h` 用 minute、`7d/30d` 用 hour；**percent 与 bytes 不混**（同一磁盘两个 key 各自返回自己的单位与量级）；`count:0` 时 summary 字段是 `null` 而非 0；`gaps.missingBuckets` 计算正确；`partialBuckets` 计数正确 |
| `server/tests/healthState.test.ts` | 连续 2 次失败仍 `degraded`、第 3 次才 `down`；**中间夹一次成功则计数归零**（抖动不告警）；恢复需连续 2 次全好；三维独立计数；全 `unknown` → `unknown`；无 `healthTarget` 时 http 维固定 `unknown` 且不探测；`reasons` 文案含维度与次数 |
| `server/tests/healthMonitor.test.ts` | 探测节流（间隔内不重复探）；**全局并发上限**（用可控 pending Promise 断言在飞数 ≤ concurrency，超出的计入 `skippedForConcurrency` 并留到下一 tick）；`intervalSec=0` 时**完全不探测**但仍评估容器维度；探测失败不清空既有状态 |
| `server/tests/alertEngine.test.ts` | 四条规则各自的触发/不触发边界；**服务连续失败 3 次只产生 1 条 firing，恢复产生 1 条 resolved**；**抖动（失败-成功-失败）在静默期内不产生第二条事件**（断言事件总数）；静默期内重开同一行（`reopen_count=1`，不插新行）；**预置未恢复行时 tick 不插新行**（重启不重复通知）；`enabled=0` 不评估；`duration` 窗口未满不触发；`suppressed` 计数正确；审计动作名齐全 |
| `server/tests/metricsApi.test.ts` | viewer 可读三个 GET；匿名 401；非法 `range`/未知 `metric`/未知 `target` → 400 且 `code=VALIDATION_FAILED`；`storage` 返回大小与保留配置 |
| `server/tests/alertsApi.test.ts` | viewer 读规则/事件 200、**PATCH 与 ack 被 403 拒绝**；admin PATCH 成功并写审计；阈值越界 400；未知 rule/event id → 404；**缺 CSRF → 403** |
| `web/tests/metricsChart.test.tsx` | 纯函数 `buildSeriesPath(points, resolution)`：**缺口断开**（不跨缺口连线）、partial 段标记、单位格式化（`percent` → `%`，`bytes` → `KB/MB/GB`，**不混淆**）；空态渲染"还没有历史数据"且不画 0 线；标注单位/数据源/采样方式/缺测数量四项都在 |
| `web/tests/alertsPage.test.tsx` | viewer 看不到规则表单与确认按钮；admin 可改阈值并 PATCH；确认按钮调用 ack；事件列表展示 reopenCount 与恢复状态 |
| `e2e/smoke.spec.ts` | 末尾追加：`/history` 打开后可读（含空态或真实曲线）、`/alerts` 列出四条内置规则且默认关闭、viewer 无管理入口；导航含 `历史`/`告警` |

**由集成方（我）编写的跨线测试**（不属于上面任何一条线的文件范围）：

| 文件 | 必须覆盖 |
| --- | --- |
| `server/tests/backgroundBoundary.test.ts` | 以源码能力边界钉住计划 §5 的"默认不外发、不自动重启容器"：三个后台模块目录存在且非空（否则守卫退化成空断言）；无 `fetch(`/`node:http(s).request`/`net.connect`/子进程/通知客户端；不得**值导入** `docker/service.js`、`docker/provider.js`、`dockerode`（`import type` 允许）；`healthProbe.ts` 只声明 `GET` 且不带请求体 |
| `server/tests/schedulerIntegration.test.ts` | 端到端证明"**浏览器关闭后仍采集**"：`buildApp({ backgroundJobs: true })` 后**不建立任何 SSE/HTTP 客户端**，直接 `scheduler.tickOnce()` + 跨分钟推进 → `metric_buckets` 出现行；单例（进程内只有一个 scheduler）；`tickOnce` 单飞（重入 `skipped: true`）；`close()` 后不再有 tick（定时器停掉）；一轮 tick 里 health → metrics → alerts 的顺序正确（告警用的是本 tick 的样本） |

**时间相关全部用注入时钟**（`clock` / `now` 参数），测试里**禁止** `await sleep` 等真实时间。
E2E 里 `buildApp` 走 `backgroundJobs: false`（或 E2E 服务端显式开启并容忍空历史）。

## 11. 非目标（本 Sprint 不做）

- 出站通知（邮件/Webhook/ntfy）、告警降噪之外的聚合日报 —— Sprint 4。
- 自动修复（重启容器）、自动扩容 —— 计划明确禁止。
- GPU/网络/每核 CPU 历史；全部容器的完整指标（只到 `PORTAL_METRICS_CONTAINER_LIMIT`）。
- 原始秒级样本长期保留（只留 minute/hour 两种分辨率）。
- 多节点指标聚合 —— Sprint 5。
- 引入图表库、时间库、调度库。

## 12. 归档要求

按仓库约定：结束时把全量改动按静态文档格式写入
`docs/static/09-changelog.md` 新条目，并同步更新
`03-server-modules.md`（新模块与函数表）、`04-api-contract.md`（新端点与错误码）、
`07-data-model.md`（迁移 v5 逐列）、`02-configuration.md`（6 个新键）、
`05-web-modules.md`（新页面/组件/纯函数）、`08-operations.md`（采集开销、库增长、
告警运维）、`todo.md`，以及 `IMPLEMENTATION_REPORT_S2.md`。

## 13. 本规格与实现的措辞差异（归档时逐条核实，**以代码与 `docs/static/03` 为准**）

冻结契约的价值在于"说清意图"，但下面几处**措辞**与最终实现不一致。逐条核实后记录在此，
避免后来者拿规格当逐字真相：

| 规格原文 | 实现事实 |
| --- | --- |
| §1.1 "一小时的 tick 只产生 2 次批量写" | **算错了**：真实是 60 次 flush + 1 次整点 rollup = **61 次/小时**（另每小时 1 次保留清理）。见 §1.1 的勘误块；可证判据是"写事务数与 tick 密度无关（1861）" |
| §3 `clock?: () => number; // 默认 Date.now` | 默认时钟是 **unix 秒**（`Math.floor(Date.now()/1000)`），全链路秒制；`TickSummary` 的三步结果实现为 `\| null`（未执行/失败），不是恒非空 |
| §3.1 `MetricsSampler` 依赖清单 | 漏列 **`health`**（实现必需，服务健康序列来自它）；实现另提供 `lastTick / availableTargets / resolveTarget / history / catalog / storage` |
| §4.2 "`intervalSec` / `concurrency` 默认读 config" | 实现默认是**常量 300 / 4**，真实配置由 `app.ts` **注入闭包**读取（这样设置页改了下一轮即生效） |
| §7 错误码只列 3 个 | 代码还会返回 `CSRF_MISMATCH`(403，缺/错 CSRF) 与 `UPSTREAM_UNAVAILABLE`(503，监视器未装配)；`limit` 越界在 HTTP 层是 **400**（服务层 `normalizeLimit()` 只是兜底） |
| §9 示例 `new AlertsService({ db, audit })` | 实际依赖还含 `config` / `logger`（不影响契约） |
| "`unknown` 不清零也不推进" | **只在服务级成立**（三维全 unknown 才保留计数）；**维度级**是 `state === 'fail' ? 续计 : 0`，某维失败后转 unknown 会让该维计数归零。另：**单个**容器 `state` 读不出来被判为容器维 **fail**（未知状态不能当作 running） |