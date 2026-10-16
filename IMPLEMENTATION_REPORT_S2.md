# HomePort 2.0 · Sprint 2 实施报告（历史趋势 / 健康监测 / 告警）

> 对应计划 `docs/HomePort_2.0_Balanced_Development_Plan.md` §5（S2-01…S2-04）。
> 设计契约冻结在 `docs/sprint2-implementation-spec.md`；逐项代码归档见
> `docs/static/09-changelog.md`，数据模型 / 接口 / 前端 / 运维分别在 `07` / `04` / `05` / `08`。
> 本文件是**升级前必读**：含迁移 v5、新环境变量、以及回滚步骤。

---

## 1. 交付概览

Sprint 2 解决两个具体缺口：**只有瞬时值、看不到历史**，以及**服务挂了没人知道**。

| 项 | 内容 | 主要文件 | 状态 |
| --- | --- | --- | --- |
| S2-01 | 指标存储：**后台单例**降采样（24h 每分钟 1 条、30d 每小时 1 条）、宿主 CPU/内存/磁盘 + 关键容器 RSS/CPU + 服务健康、批量写 + WAL + 保留清理 + 缺测 gap、迁移 **v5** | `server/src/modules/metrics/{buckets,collector,sampler,history,scheduler}.ts`、`db/database.ts` | ✅ |
| S2-02 | 历史图表：1h/24h/7d/30d（分钟/小时两分辨率）、单位与数据来源标注、**缺测不写 0**、磁盘百分比与字节永不混算 | `server/src/api/metrics.ts`、`modules/metrics/history.ts`、`web/src/pages/HistoryPage.tsx`、`components/MetricsChart.tsx` | ✅ |
| S2-03 | 健康检查：容器生命周期 + Docker health + 独立 HTTP 探测三维独立计数、连续 N 次失败才 `down`、恢复需连续 2 次全好、可配间隔与**全局并发上限** | `server/src/modules/health/{state,monitor}.ts`、`api/healthMonitor.ts` | ✅ |
| S2-04 | 告警：四条内置示例规则**默认关闭**、界面开关/阈值/静默期、episode 模型 + 恢复通知 + 确认与审计、**一小时内不重复刷屏** | `server/src/modules/alerts/{rules,engine,service}.ts`、`api/alerts.ts`、`web/src/pages/AlertsPage.tsx` | ✅ |
| 附 | **修掉一个 P0 级装配缺口**：告警引擎没接快照来源 → 生产上告警静默失效（单测全绿也照样失效） | `server/src/app.ts`、`server/tests/schedulerIntegration.test.ts` | ✅ |
| 附 | 顺带修掉两个真缺陷：设置分组漏声明（设置页少 6 个键）、`ContainerSummary` 未映射退出码（"容器异常退出"规则名不副实） | `settings/service.ts`、`docker/{types,mapper}.ts` | ✅ |
| 附 | **规格勘误**：§1.1 我写的"每小时只 2 次批量写"是错的（真实 61 次/小时），已改正并换成机器可证判据 | `docs/sprint2-implementation-spec.md` | ✅ |
| 附 | **验收驳回后修复三个 P1**（隐藏服务经监控/历史接口泄漏 ×2、服务端测试依赖墙钟）：可见性在**读取侧**也被强制、`state(ref)` 对不可见 ref 返回 `null`、两条装配线改用固定 epoch + 假数据源。见 §2.8 | `health/monitor.ts`、`metrics/sampler.ts`、`api/metrics.ts`、3 个测试文件 + 2 个新测试文件 | ✅ |

**没有新增任何依赖**（后端未引入通知/HTTP 客户端库，前端未引入图表库 —— 折线图是手写 SVG）。

---

## 2. 逐项变更

### 2.1 S2-01 指标存储（后台单例）

- **每个前端会话一份采集是错的**，所以采样是**后台单例**：`BackgroundScheduler` 按固定顺序
  **health → metrics → alerts** 跑一轮（顺序是契约），`tickOnce(now?)` 支持注入时钟与单飞
  （重叠轮次返回 `skipped: true`，不排队、不雪崩）。`backgroundJobs` 只控制**定时器**是否启动，
  采样器/监视器/引擎**始终构造** —— 因此 `backgroundJobs: false` 时读接口照常可用，
  且"零浏览器连接仍在采"这件事**有测试**（`schedulerIntegration.test.ts` 用零 SSE/HTTP 客户端）。
- **内存累积 + 分钟落库**：tick 只把样本累加进当前分钟累加器（`sum/count/min/max`，
  按 `metric|target` 分桶），跨过分钟边界时把**已结束**的分钟批量写库；整点再从 minute 行
  聚合出 hour 行（`SELECT ... GROUP BY bucket_at`），所以**重启能补上停机期间的整点**。
- **缺测语义（S2-02 的前提）**：缺的分钟**没有行**，永远不写 0；`samples < expected` 才标 `partial`
  （`expected` 分钟桶 = `max(1, round(60/intervalSec))`、小时桶 = 60、多副本时 × 副本数）。
  写 0 会把"采样失败"画成"0% 占用"，那是**主动误导**。
- **预算**：库大小按 `page_count × page_size` 报出（不是含 WAL 的"文件多大"），
  稳态上限 32 MB，`GET /api/metrics/storage` 给出 `withinBudget`。

### 2.2 S2-02 历史图表

- 4 个范围映射到两个分辨率（`1h/24h` 用 minute、`7d/30d` 用 hour），一次 SELECT 只取窗口内数据。
- **空窗口 `summary` 的 `avg/min/max/latest` 是 `null` 而不是 0**（有测试显式断言 `avg !== 0`），
  界面给"还没有历史数据"的空态，**不画一条贴底的平线**。
- **磁盘百分比与磁盘字节永不混算**：同一块磁盘的两个 key 各自返回自己的 unit 与量级，
  后端零换算、前端标单位（有专门用例，含"bytes 量级 > 1MB 而 percent ∈ [0,100]"的交叉验证）。
- 图表标注单位、数据来源、缺测与聚合方式（分钟均值 / 小时均值）。

### 2.3 S2-03 健康检查

- 三维独立计数（容器状态 / Docker health / HTTP 探测），**永远不合并成"服务挂了"**；
  连续 N 次失败才 `down`（默认 3），恢复需**连续 2 次全好**，抖动（失败-成功-失败）立刻清零计数器。
  **`unknown` 的语义要分清两级**：**维度级**是"不 fail 就视为不续计"（`state === 'fail' ? 续计 : 0`），
  所以某维失败 2 次后转 `unknown` 会让**该维计数归零**；**服务级**只有在**三维全 `unknown`** 时
  才保留既有计数 —— 既不判定好也不判定坏（"不知道"不等于"好"，也不等于"坏"）。
  这一点在规格早期被我写成了笼统的"`unknown` 不清零也不推进"，实现在维度级更严格，此处按代码更正。
- **HTTP 探测与容器状态相互独立**：探测失败只判 http 维、保留既有容器维与状态；
  容器列表整体取不到时容器维 `unknown` —— **不拿过期快照冒充现状**。
  （另一件事不要混淆：**单个**容器的 `state` 读不出来时，该容器被记为该维 **fail** 而不是 unknown，
  因为"未知状态"不能当作"正在运行"；文案是「状态异常（unknown）」。
  容器维的合格条件是**全部副本都 running**。）
- 可配探测间隔（`0` = 完全关闭探测，但仍评估容器维度）与**全局并发上限**
  （超出计入 `skippedForConcurrency` 留到下一 tick，不会堆积请求）。
- 探测是 `server/src/modules/health/healthProbe.ts` 的**只读 GET**（无请求体、不跟随跳转、3s 超时）。

### 2.4 S2-04 告警

- 四条内置示例规则（磁盘使用率 / 内存使用率 / 容器异常退出 / 服务连续探测失败）**默认 `enabled = 0`**：
  装了但不吵，由管理员显式开启。阈值、`duration`、静默期、严重级都可在界面改。
- **episode 模型**：`alert_events` 一行代表一次故障过程，`resolved_at IS NULL` 唯一
  （部分唯一索引 `idx_alert_events_open` 是裁判，不是实现细节）→ 同一规则同一目标
  **最多一行未恢复**，这就是"不刷屏"的结构性保证（不是靠计数器）。
- **静默期内再次触发是重开同一行**（`reopen_count + 1`，并清空确认状态），不插新行；
  超过静默期才开新行 → "一小时内不重复"可被机器断言。
- **`duration` 门控计时在内存**：重启后重新计时（宁可晚一轮，不误报）；条件一旦不成立立刻清零，
  所以抖动不会累积成告警。`suppressed`（未恢复时又被触发）与 `reopened`（静默期内重开）
  **分开计数**，语义不混。
- **引擎不做任何出站调用、不重启任何东西**：确认（ack）只在界面与库里留痕，并写审计
  （`alert.fired` / `alert.resolved` / `alert.reopened` / `alert.acknowledged` / `alert.rule_updated`）。

### 2.5 P0 级装配缺口：告警曾经"生产上完全静默"（本轮最重要的发现）

**现象**：`AlertEngine` 在 `app.ts` 里构造时**没有接 `snapshot` 来源**，而调度器只调
`alerts.tick(now)` 一个参数 → 引擎每轮拿到**空快照** → 四条规则永远 `evaluated = 0` →
**任何告警都不会触发或恢复**。

**为什么单测抓不到**：引擎的 36 条用例都是"自己把快照传进去"的；引擎拿到空快照时的行为是
**"正确地什么都不做"**（无异常、无日志、结果形状完全合法）。这是**装配缺口**而非逻辑错误 ——
每一块都对，缺的是把它们接起来。

**修复**：`app.ts` 接入 `createAlertSnapshotSource({ config, system, containers, registry, health, logger })`，
并把每轮结果回灌服务层（`onTick → alerts.recordTick`），使 `GET /api/alerts/summary` 的
`suppressed`/`evaluatedAt` 是真值。

**补的覆盖（并验证了判别力）**：`server/tests/schedulerIntegration.test.ts` 新增端到端因果链用例 ——
真实装配 + 假读数驱动，断言：窗口未满不触发 → 满窗口触发恰好 1 条（且文案含"已持续"）→
故障期不重复且 `suppressed > 0` → 恢复写回**同一行**且不新增 → 静默期内重开 `reopen_count = 1`
且行数仍为 1 → 三个审计动作齐全。

```
# 判别力（实测）：只撤掉 app.ts 里那一行 snapshot 接线
× 磁盘持续超标 → … › 引擎必须真的拿到快照并评估到规则 —— 这条断言就是"装配漏接 snapshot"的照妖镜:
  expected 0 to be greater than 0
```

### 2.6 顺带修掉的真缺陷

1. **设置分组漏声明**：`settings/service.ts` 的 `groupList()` 是手抄副本，漏了 `metrics`/`health`
   两组 → 设置页**少渲染 6 个键**（能存、能改、界面看不见）。改为直接返回 `SETTING_GROUPS` 同源，
   `auth.test.ts` 39 条全绿且**未改任何断言**（它是裁判，不能弱化）。
2. **`ContainerSummary` 未映射 `State.ExitCode`**：`exited` 容器的退出码恒为 `null`，
   而规格要求"未知退出码不触发" → **"容器异常退出"这条内置规则只能靠 `dead` 触发，名不副实**。
   已补 `exitCode` 映射（**不用 `?? 0`**：`null` = 未知、`0` = 正常退出，两者都沉默但语义不同）
   + 5 条 mapper 用例。
3. **E2E 登录被限流挡住（测试基础设施缺陷，不是产品缺陷）**：`LOGIN_RATE_LIMIT` 是写死在
   `server/src/api/auth.ts` 的安全常量（10 次/分钟），Sprint 2 新增两条用例后登录次数达 11 次/分钟，
   末尾用例被 429 挡在登录页（症状表现为"登录页标题一直不消失"，且**日志里没有 401**，
   因为那是正常的未认证响应 —— 靠服务端 `RATE_LIMITED` 日志才定位到真因）。
   **没有放宽限流**（那会削弱暴力破解防护），而是让每个角色只走一次真实登录表单、
   其余复用缓存会话，并在缓存会话被「退出」真正撤销时**自愈重登**。

### 2.7 规格勘误（我写错的判据）

规格 §1.1 原文写"一小时的 tick 只产生 **2 次**批量写" —— **这是错的**：漏掉了 flush 发生在
**每个分钟边界**。30s 间隔下真实是 **60 次 flush + 1 次整点 rollup = 61 次/小时**。
实现按机制原文走，判据换成三条**机器可证**的形式：①**写事务数与 tick 密度无关**
（30s 与 5s 两种间隔跑同样时长写事务数完全相同 = 1861）；②整点那一 tick 恰好 2 次批量写；
③与前端会话数无关。

**被否决的替代方案**：攒到整点才 flush 能真正做到字面"2 次/小时"，代价是**当前小时只存在于内存**，
重启最多丢 59 分钟、1h 视图在整点前恒为空 —— 与"24h 每分钟 1 条""重启后历史保留"直接冲突。
重启数据损失上界因此是 **1 个采样间隔**。

### 2.8 验收驳回后的修复：三个 P1（本轮）

Sprint 2 提交后，用户**手工复现真实场景**驳回了三个 P1。三条同属一类：
**"看得见什么"只做了一半就被当成做完了** —— 采集侧固定 viewer 视角看着安全，
但**读侧**与**清理路径**各留一个缺口；而测试因为把"跑测试的真实时刻"当输入，
既挡不住缺口、自己还会时红时绿。逐项记录（现象 / 根因 / 修法 / 验证证据），
逐项明细另见 `09-changelog.md` 最后一条。

#### P1-1 健康监视器把已隐藏的服务状态与**服务名**永久留在内存

- **现象**：把服务全部隐藏（或删除）后，`GET /api/health/monitor` 仍列出它们，
  `services[].label` 就是服务名 —— 用户的"隐藏"被后台绕过。
- **根因**：`tick()` 里写的是 `if (tracked.length > 0) dropStaleStates(tracked)`。
  `loadServices()` 把"`list()` 抛错"与"成功读到空列表"都返回 `[]`，
  于是**成功读到空列表**（= 用户全隐藏/全删）与"这次没读到服务列表"不可区分，
  条件 `tracked.length > 0` 让两者**都**跳过 reconcile；而且 `dropStaleStates()` 原来只删
  `statesByRef`，**`labelsByRef` 里的服务名不受影响** —— 名字照旧能从视图取出来。
- **修法**：①`loadServices()` 返回带 `ok` 判别位的 `ServiceListViewResult`
  （抛错或响应缺 `items` = `ok: false`；正常返回含空 `items` = `ok: true`），
  **不靠"数组是否为空"事后猜**；②`loaded.ok` 时更新 `visibleRefs` 并 `dropStaleStates()`
  —— **空列表也走全清**，且同时删 `labelsByRef`；
  ③读失败时不碰任何既有状态、`visibleRefs` 不变，原因进 `view().notes`；
  ④**读路径纵深防御**：`visibleRefs` + `isVisible()`，`states()` / `state()` / `view()` 都过滤
  （`null` = 还没成功读过则不过滤）。
- **被本轮推翻的表述（须一起改）**：本文档此前默认 `state(ref)` 只要内存里有就返回状态；
  **现在对不可见 ref 返回 `null`**（语义收紧）。连带影响：`MetricsSampler.verdictOf` 是
  `health.state(ref)?.verdict ?? 'unknown'` → "不可见"在采样侧表现为 `unknown` → 该 tick
  不产生样本（方向安全：宁缺测不写 0）；`AlertEngine` 快照用 `health.states()` →
  隐藏服务从快照消失（后果见 §7-9）。
- **验证证据**：`healthMonitor.test.ts` 新增 4 条（现 21 条）。其中"读路径纵深防御"一条
  **故意绕过 `dropStaleStates()`** 往 `statesByRef` / `labelsByRef` 里塞回一个不可见的
  `docker:ghost`，断言 `states()` / `state()` / `view()` 都不发出它 —— **只修写路径的版本在这条下会红**；
  另一条对 `JSON.stringify(view())` 断言**连服务名都不出现**。

#### P1-2 历史指标读接口绕过当前可见性

- **现象**：服务被采集过、随后被隐藏，viewer 仍能在 `/api/metrics/catalog` 看到它的 target 与
  `targetLabel`（= 服务名），并能在 `/api/metrics/history` 查到完整曲线，直到历史过期（24h / 30d）。
- **根因**：采集侧固定 `role: 'viewer'` 只保证"隐藏之后不再产生新样本"，
  **隐藏之前**已落库的行与进程内 `liveTargets` 仍带服务名，而读路径
  `availableTargets()` 直接遍历 `repo.listTargets()`、`resolveTarget()` 直接查存在性，
  **两处都没核对当前 hidden**。**读取侧整半缺失。**
- **修法**：新增 `visibleServiceRefs()`（与采集同一个 `backgroundHostRequest(config)`，
  **刻意不缓存 —— 任何 TTL 都是泄漏窗口**，见 §7-8）、`isHostOwnedTarget()`、`targetVisible()`；
  `availableTargets()` / `resolveTarget()` / `catalog()` 改 **async** 并按**当前**可见性过滤；
  注册表读失败 **fail-closed**；`resolveTarget()` 在**任何存在性查找之前**先过可见性，
  因此"被隐藏"与"从未采集过"返回**同一条** 400 `VALIDATION_FAILED` + `targetPattern`
  —— **刻意不用 404/403**（那等于承认该目标存在），也没有任何区分字段。
- **验证证据**：新增 `metricsVisibility.test.ts` **13 条**，全走 `buildApp()` + `app.inject()`
  （真实路由 / 会话 Cookie / CSRF / SQLite），夹具是**真的采集**（建手工服务 → 健康判定 → 采样落库 →
  隐藏）。核心断言：隐藏目标的 400 与陌生 target 的 400 在**抹平调用者自己传入的 target 串后
  逐字节相同**（`Object.keys(error)` 也相同）；`admin` 会话同样看不到（**不做角色特例**）；
  宿主指标不受影响；恢复可见后曲线与隐藏前**逐字段相同**（行没被删）。
  **判别力（本次实测，归档未复跑）**：临时关掉读路径过滤 → 13 条里 12 条依赖可见性的用例有 **6 条变红**。

#### P1-3 两条服务端测试用墙钟构造起点

- **现象**：同一份代码一天里时红时绿。`schedulerIntegration.test.ts` 的
  `BASE = minuteStart(Date.now()/1000) - 3600` **必然横跨一个整点** → 整点滚动凭空多出 hour 行，
  而断言是"总行数 === 本轮 flush 的行数"，实测出现 `10 === 5`；`metricsApi.test.ts`
  用 `Date.now()` 取 T0 并用墙钟推导保留截止时刻 → 23:01 跑时 T0 落到上一个整点，hour 桶被滚出而
  断言仍写"hour 窗口为空"。
- **根因**：起点来自真实墙钟 = **"跑测试的真实时刻"成了输入**；同时依赖真实宿主采样器与真实 Docker
  （"这台机器恰好有没有 CPU 基线"也成了输入）。这类缺陷不编译报错、不运行抛错，只在某些时刻红。
- **修法**：两条线改用**固定 epoch** `1_700_000_000`（`BASE = hourStart(EPOCH) + 15min`；
  `metricsApi` 用 `vi.setSystemTime`）+ **三个数据源全部换成注入假夹具**（序列数因此是确定值，
  断言由区间收紧为等号）+ 每个"本该没有 hour 行"处**显式断言 `hoursRolledUp === 0`** +
  **新增跨整点用例**（22:59:30 → 23:00:30，含"未结束的整点不许提前滚出"与幂等）。
  另新增守卫 `clockBoundary.test.ts`（4 条：扫源码禁止 `Date.now(` / `new Date(` /
  `performance.now(`，要求同一个 `EPOCH` 与三个注入点，受约束文件缺失或为空时必须失败）。
- **验证证据**：实测 `npx vitest run tests/{clockBoundary,healthMonitor,metricsVisibility,metricsApi,schedulerIntegration}.test.ts
  --root server` → **5 文件 / 59 用例全绿**（4 / 21 / 13 / 14 / 7）。
- **顺带发现的真问题（装配顺序，不是本轮要修的缺陷）**：`buildApp` 内部的
  `settings.initialize()` 会把设置层默认值**就地写回同一个 `config` 对象** ——
  测试传进去的 `sampleIntervalSec = 5` 会被"设置默认值 30"取代（实测 `expected` 从 12 变成 2）。
- **被本轮推翻的表述（已在本文档就地更正）**：①§1 的交付表原来没有这一轮，
  已补一行"验收驳回后修复三个 P1"；②§4.3 原文那句"后台只采 viewer 可见的服务，
  避免隐藏服务名从 viewer 可读的历史接口泄漏"在**本轮之前只有前半句成立**，已改写并说明落点有两处；
  ③§6.1 的证据台账是**本轮之前**的，已补本轮的实测命令与结果（5 文件 / 59 用例）；
  ④§6.2 新增"用户复现驳回项的收口"三行；⑤§7 新增风险 8–12。

---

## 3. 数据库迁移 v5（升级前必读）

**只追加**，v1–v4 一列未动；启动时自动应用，无需手工步骤。

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `metric_buckets` | 分钟/小时聚合桶（13 列） | `UNIQUE (resolution, metric, target, bucket_at)` = "同一桶幂等重写"的裁判；另有 `idx_metric_buckets_series`、`idx_metric_buckets_retention` |
| `alert_rules` | 告警规则（14 列，`enabled DEFAULT 0`） | 内置四条按 `id` 幂等补齐 |
| `alert_events` | 故障过程（episode，18 列） | **部分唯一索引 `idx_alert_events_open (rule_id, target) WHERE resolved_at IS NULL`** = "同一规则同一目标最多一行未恢复"的不变量；另有 `idx_alert_events_recent` |

**真实库副本演练（15/15 × 2，只读源 → 临时副本）**：

```
node migrate-rehearsal-s2.mjs portal-v4-fixture.sqlite portal-live-pre-sprint1.sqlite
# v4 库 → 应用 v5；v3 备份 → 应用 v4 + v5
# 两次均：用户/会话/审计/设置条数不变、密文逐字未变、3 表 4 索引齐备、
#         新表迁移后为空、重复迁移 0 个（幂等）
```

**回滚**：迁移是不可逆的（追加式）。回滚 = **用升级前的备份恢复**（见 `08-operations.md` §10：
WAL 模式下必须用 `VACUUM INTO` 做一致性导出，或停容器后整卷打包；**只拷 `portal.sqlite`
会静默丢数据**）。旧镜像可以读 v5 库（多三张表不影响旧代码），但新代码不能读缺表的旧库。

---

## 4. 配置与接口变更

### 4.1 新增环境变量 / 设置键（6 个，全部 `effect: 'live'`）

| 键 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` | 30 | 5–3600 | 采样间隔；同时决定 `expected`（每分钟应有几个样本） |
| `PORTAL_METRICS_RETENTION_MINUTE_HOURS` | 24 | 1–168 | 分钟级保留窗口 |
| `PORTAL_METRICS_RETENTION_HOUR_DAYS` | 30 | 1–3650 | 小时级保留窗口 |
| `PORTAL_METRICS_CONTAINER_LIMIT` | 10 | 0–100 | 采多少容器的 RSS/CPU（0 = 不采容器） |
| `PORTAL_HEALTH_PROBE_INTERVAL_SEC` | 300 | 0–86400 | **0 = 关闭 HTTP 探测**（仍评估容器维度） |
| `PORTAL_HEALTH_PROBE_CONCURRENCY` | 4 | 1–32 | 全局并发上限 |

三层优先级不变（数据库覆盖 > 环境变量 > 内置默认），界面可改、下一个周期即生效。

### 4.2 新增 HTTP 接口（9 个）

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `/api/metrics/catalog` | viewer |
| GET | `/api/metrics/history?metric=&target=&range=` | viewer |
| GET | `/api/metrics/storage` | viewer |
| GET | `/api/alerts/rules` | viewer |
| PATCH | `/api/alerts/rules/:id` | **admin + CSRF** |
| GET | `/api/alerts/events?state=&limit=` | viewer |
| POST | `/api/alerts/events/:id/ack` | **admin + CSRF** |
| GET | `/api/alerts/summary` | viewer |
| GET | `/api/health/monitor` | viewer |

读接口 viewer 即可、无需 CSRF；写接口要求 admin + 有效 CSRF；匿名一律 401。
`GET /api/alerts/rules` 的响应是 `{ items: [...] }`（**不是裸数组**）。
错误码沿用既有：`VALIDATION_FAILED`(400)、`NOT_FOUND`(404)、
`FORBIDDEN`(403，角色不足)、`CSRF_MISMATCH`(403，缺/错 CSRF 令牌 —— 与"角色不足"是**两个不同理由**，
测试里分别断言，不能混为一谈)、`RATE_LIMITED`(429)；
健康监视器未装配时返回 `UPSTREAM_UNAVAILABLE`(503)，而**不是**伪装成"没有服务"的空数组。

### 4.3 后台模块的"无出站能力"是**可执行约束**

`server/tests/backgroundBoundary.test.ts` 扫描 `modules/metrics|health|alerts` 与 `backgroundContext.ts`，
断言：无 `fetch` / `http(s).request` / `net.connect` / `child_process` / `nodemailer|axios|node-fetch|undici`、
不直连 `/var/run/docker.sock`、不**价值导入** docker 的 `service.js`/`provider.js`/`dockerode`
（`import type` 允许），且健康探测只声明 `GET`、无请求体。意义：Sprint 2 **不做外发通知、不自动修复**
（通知渠道到 Sprint 4）。

> **此处原文有过一句被本轮推翻的话**："后台只采 viewer 可见的服务，避免隐藏服务名从 viewer 可读的
> 历史接口泄漏。" —— **前半句成立，后半句当时并不成立**：采集侧固定 viewer 只保证
> "隐藏之后不再产生新样本"，**隐藏之前**已落库的行与内存 `liveTargets` 仍带着服务名，
> 读接口照样列出与查询（这正是被驳回的 P1-2）。现在这句话才真正成立，
> 而且落点在**两处**：采集侧（既有）+ **读取侧**（本轮新增，`MetricsSampler.visibleServiceRefs()`
> 与 `HealthMonitor` 的 `visibleRefs` / `isVisible()`）。见 §2.8 与 `06-security.md` §3 的不变量表。

---

## 5. 升级与回滚

```bash
# 1) 备份（一致性导出，不停机；WAL 模式下不要只拷主文件）
docker compose exec homeport sh -c \
  'sqlite3 /data/portal.sqlite "VACUUM INTO '"'"'/data/backup-$(date +%F).sqlite'"'"'"'

# 2) 升级（数据卷不动）—— 启动即自动应用迁移 v5
docker compose pull && docker compose up -d --remove-orphans

# 3) 核对
docker compose exec homeport sh -c \
  'sqlite3 /data/portal.sqlite "SELECT version,name FROM schema_migrations ORDER BY version"'
# 期待看到 5|metrics_alerts_schema，且 1..4 仍在
```

回滚：恢复备份（换回旧镜像即可，旧代码能读 v5 库）。
**绝不要 `docker compose down -v`** —— 那会删掉数据卷。

---

## 6. 验收记录

### 6.1 实测证据

```
npm run typecheck   # exit 0（server + web）
npm test            # 提交时：server 31 文件 / 594 用例全绿；web 10 文件 / 172 用例全绿
npm run build       # exit 0
npm run test:e2e    # 12 用例通过（10 冒烟 + 2 安全响应头），耗时 32s
# 迁移演练（真实库副本）：v4→v5、v3→v4→v5 各 15/15 通过，幂等
# 判别力：只撤掉 AlertEngine 的 snapshot 接线 → 端到端告警用例红在 evaluated > 0
```

**验收驳回修复后的新增证据（本轮，2026-10-16 23:15 实测）**：

```
npx vitest run tests/clockBoundary.test.ts tests/healthMonitor.test.ts \
  tests/metricsVisibility.test.ts tests/metricsApi.test.ts \
  tests/schedulerIntegration.test.ts --root server
# → Test Files 5 passed (5)；Tests 59 passed (59)
#   clockBoundary 4（新）/ healthMonitor 21（+4）/ metricsVisibility 13（新）
#   metricsApi 14（改造）/ schedulerIntegration 7（改造 + 跨整点用例）
# 判别力（修复方实测，本次归档未复跑）：
#   临时关掉读路径可见性过滤 → metricsVisibility 13 条里 12 条依赖可见性的用例有 6 条变红
# clockBoundary 守卫的可判别性：往受约束文件里加一行 Date.now() 即红
# 注：全库 npm test / typecheck / E2E 由父任务在提交前统一跑，本报告不据此宣称
```

E2E 新增覆盖：历史页导航 + 空历史**不画 0 线** + 存储/保留配置真的通到接口 +
四条内置规则默认关闭（用同源 API 断言真实值，不信界面渲染）+ 告警页 viewer 只读
（带**有效 CSRF** 的写请求仍被 403 拒，证明是角色鉴权而非缺 CSRF）。

### 6.2 计划 §5 验收清单对照

| 验收要求 | 结论 |
| --- | --- |
| 空闲时采样 24h 后能看到完整曲线 | ✅ 30h 确定性仿真：24h 窗口每序列恰好 1440 点；重启后曲线仍在 |
| 数据量与库大小被记录、符合预算 | ✅ `storage()` 报行数/`page_count × page_size`/保留截止时刻/`withinBudget`；判据已勘误为可证形式 |
| 1h / 24h / 7d / 30d 历史图表 | ✅ 两分辨率映射 + 一次 SELECT 只取窗口内；30 天整点仿真真跑出 720 条 hour 行 |
| 不把磁盘百分比与字节混淆 | ✅ 同磁盘两 key 各带自己的 unit 与量级，后端零换算，有交叉验证用例 |
| 缺数据要说明（不能静默画 0） | ✅ 缺测无行 + `gaps` + `partial`；空窗口 `summary` 为 `null`；界面有"还没有历史数据"空态 |
| 假服务连续失败按规则仅发一次告警 | ✅ 端到端：窗口满触发恰好 1 条，故障期 `suppressed > 0` 而不新增 |
| 恢复后发一次恢复通知 | ✅ 恢复写回**同一行**的 `resolved_at`，不新增事件行；审计 `alert.resolved` |
| 短暂网络抖动不造成告警风暴 | ✅ 抖动清零计数；静默期内重开同一行（`reopen_count = 1`），行数仍为 1 |
| 告警默认不打扰（示例规则默认关闭） | ✅ 四条内置规则 `enabled = 0`，界面显式开启；E2E 用同源 API 断言真实值 |
| 告警可确认、有审计 | ✅ `ack` 幂等（重复确认保留首次时间）+ `alert.acknowledged` 审计；viewer 不可写（带有效 CSRF 也 403） |
| 后台采样不随前端会话线性增长 | ✅ 后台单例；零 SSE/HTTP 客户端时 tick 照样写库；写事务数与 tick 密度无关 |

**用户复现驳回项的收口（本轮补测，见 §2.8）**：

| 驳回项（P1） | 结论 |
| --- | --- |
| 隐藏服务仍出现在 `GET /api/health/monitor`（含服务名） | ✅ 已修：成功读到空列表也全清（状态 + `labelsByRef`），读路径再拦一道；`healthMonitor.test.ts` +4 条，含"绕过 reconcile"的可区分性用例 |
| 隐藏服务仍可经 `/api/metrics/catalog` 与 `/history` 枚举/查询 | ✅ 已修：读路径按**当前** viewer 可见集合过滤，不可见与"从未采集过"返回**逐字节一致**的 400（无 404/403）；`metricsVisibility.test.ts` 13 条 |
| 两条服务端测试依赖墙钟（必然/可能横跨整点） | ✅ 已修：固定 epoch + 三个注入假夹具 + 显式 `hoursRolledUp === 0` + **新增跨整点用例** + `clockBoundary.test.ts` 守卫；5 文件 59 用例全绿 |

---

## 7. 风险与已知限制

1. **不做外发通知、不做自动修复**（Sprint 4 才加渠道）。告警只在门户内可见；
   引擎**刻意**没有任何出站能力，并由 `backgroundBoundary.test.ts` 钉住 —— 这是**设计约束**，不是缺口。
2. **`duration` 计时在内存**：进程重启后重新计时，因此重启瞬间正在累积的故障会晚一轮才告警
   （取舍：宁可晚一轮，也不误报）。
3. **`container_exit` 依赖 `State.ExitCode`**：未知退出码（`null`）不告警 —— 宁可漏报也不误报；
   `dead` 状态可直接触发。
4. **多副本合并为一条序列**：同一 compose 服务的多个副本在历史里是一条线（值是多副本均值），
   `expected` 按副本数放大，所以"掉一个副本"会正确显示 `partial`；
   但**看不到"另一个副本也在跑"**（同 Sprint 1 已知限制，绑定只留代表容器）。
5. **`e2e/**` 仍不在类型检查内**：本轮又踩到一次（断言写错但 `typecheck` 无感）。
   已记入 `todo.md` 技术债，未混进 Sprint 2 提交。
6. **登录限流不可配置**：10 次/分钟是硬编码常量。E2E 侧已改为复用会话，
   但若将来用例继续增长，需要先论证再决定是否做成可配置项。
7. **`notifyRecovery` 已进契约但 Sprint 2 没有运行时效果**：该字段会被保存并写进 `alert.resolved` 审计，
   但"恢复通知"本身依赖 Sprint 4 的通知渠道。规则表单如实展示它，**不假装现在就会发通知**。

**验收驳回修复带出的新增风险（本轮，照实记录；均未在本次修复中解决）**：

8. **可见性刻意不缓存 → 每次读都查一次注册表**：`visibleServiceRefs()` 不复用任何 TTL
   （"任何 TTL 都是泄漏窗口"）。默认 `PORTAL_CACHE_CONTAINERS_TTL_MS = 2000` 时这一次读被服务注册表
   既有的 TTL 缓存吸收（不产生 Docker 调用，并发读由 single-flight 合并）；
   **但该 TTL 允许设为 0（不缓存）**，那时每个 `/api/metrics/catalog` 与每个服务类
   `/api/metrics/history` 都会真的跑一遍服务发现。这是**有意的**安全优先取舍；
   若将来要优化，**不能**用"给可见性加 TTL"的办法（那等于把泄漏窗口换回来）。
9. **告警读接口是同一类泄漏面上仍未收口的一块**：`/api/alerts/events` / `summary` 返回的
   `target` / `target_label` 是**触发时**写进 `alert_events` 的，不随可见性变化 →
   隐藏前产生的告警事件仍会带出服务名。且隐藏后 `health.states()` 不再包含该服务，
   引擎"目标不在快照里 → 不动，不假恢复"的既有语义让它的未恢复告警**停在未恢复状态**
   （既不会自动恢复、也不会再触发）。本轮范围只覆盖 `/api/metrics/*` 与 `/api/health/monitor`
   （即用户驳回的三条 P1）。详见 `06-security.md` §9-11 与 `todo.md`。
   修法同形，但**必须先决定"隐藏服务的未恢复告警算不算还在故障"** —— 那是产品语义，不只是过滤。
10. **`state(ref)` 语义收紧把两个模块的口径绑在一起**：`MetricsSampler.verdictOf` 走
    `health.state(ref)?.verdict ?? 'unknown'`，因此"不可见"在采样侧表现为 `unknown` → 该 tick
    不产生样本（方向安全，宁缺测不写 0）；`AlertEngine` 快照用 `health.states()` →
    隐藏服务从快照消失（即第 9 条）。**改任一处都要一起看**。
11. **`visibleServiceRefs()` 的 fail-closed 分支没有单测**：现有用例都通过"真隐藏 / 真删除"走到
    `visible = Set(...)`；"注册表抛错 → 服务/容器类 target 全部不可见、宿主与磁盘不受影响"
    目前只有实现与注释，**没有可区分性证明**。补法简单（注入抛错的 registry 走真实路由），本轮未做。
12. **台账未同步**：`docs/sprint2-implementation-spec.md` §3.1 仍写着
    `availableTargets / resolveTarget / catalog` 的**同步**签名（实现已改 async 并多一层可见性校验），
    冻结规格本轮未改；`README.md` 的测试规模数字也仍是 Sprint 2 提交时的值
    （本轮 **+2 文件 / +21 用例**）。均已记入 `todo.md`。

---

## 8. 未做项与下一 Sprint 前置

- **未部署到 NAS**：生产仍是 Sprint 0 镜像。Sprint 1 + Sprint 2 待一起部署验收
  （升级前必读：本报告 §3/§5 与 `08-operations.md` §7.2）。
- **待用户拍板的既有问题（Sprint 1 遗留，未变）**：接受 `trustProxy = loopback`；
  是否把只读 socket 代理作为 NAS 默认；E2E 是否纳入发布依赖链；
  6 处前端缺陷修复时机。
- **函数级静态文档重建（方案已定，时机已到）**：Sprint 2 已提交、三条开发线文件全部落地，
  接下来用 `code-static-documentation` 为 `server/src` + `web/src` + 配置共约 125 个文件
  生成 `docs/static/code/**`（每篇文档头记录本次 commit hash）。
- **下一 Sprint 前置**：Sprint 3 的通知渠道需要 `AlertEngine` 的触发点已经稳定 ——
  本轮把"引擎不做任何出站调用"变成可执行约束，Sprint 3 加渠道时应**新增独立的通知模块**，
  而不是把 `fetch` 塞进引擎（届时 `backgroundBoundary.test.ts` 的白名单要同步扩，
  并在报告里说明扩了什么、为什么）。
- **验收驳回修复留下的未做项**（本轮范围只到用户驳回的三条 P1，逐条见 §7-8…12）：
  ① `visibleServiceRefs()` 的 fail-closed 分支补一条单测；
  ② **告警读接口按可见性收口**（`/api/alerts/events` 与 `summary` 的 `target` / `target_label`
  仍会带出隐藏前的服务名），且要先决定"隐藏服务的未恢复告警算不算还在故障"这条产品语义；
  ③ 回填 `docs/sprint2-implementation-spec.md` §3.1 的签名清单（已改 async）与
  `README.md` 的测试规模数字（本轮 +2 文件 / +21 用例）。
  以上均已写入 `todo.md` 的「Sprint 2 验收驳回修复的未做项与残留风险」。