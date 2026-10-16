# HomePort 2.0 · Sprint 1 实施报告（服务注册表 / 服务墙 / 快捷搜索）

> 对应计划 `docs/HomePort_2.0_Balanced_Development_Plan.md` §4（S1-01…S1-05）。
> 设计契约冻结在 `docs/sprint1-implementation-spec.md`；逐项代码归档见
> `docs/static/09-changelog.md`，数据模型 / 接口 / 前端 / 运维分别在 `07` / `04` / `05` / `08`。
> 本文件是**升级前必读**：含迁移 v4、**一处对用户可见的路径破坏性变更**、以及回滚步骤。

---

## 1. 交付概览

Sprint 1 解决的问题是首页"看不懂"：门户此前把**容器**当成入口单位展示，于是
"家庭日历"是一个容器 + 一条 `127.0.0.1:36065` 的端口 + 三条 `tailscale serve` 路径，
用户需要自己拼出"我到底该点哪个"。Sprint 1 引入**服务**这一层：
把容器与 serve 路由归纳成用户认得的东西，每个服务给**唯一首选入口**，但**保留全部候选**。

| 项 | 内容 | 主要文件 | 状态 |
| --- | --- | --- | --- |
| S1-01 | 数据模型：`services` / `service_bindings` / `service_preferences`（迁移 **v4**）、稳定身份、用户覆盖保护 | `server/src/db/database.ts`、`db/types.ts`、`db/services.ts` | ✅ |
| S1-02 | 入口优先级（用户 0 > Serve 1 > Tailnet 2 > LAN 3 > 仅本机 4）、去重、规范化、全候选保留 | `server/src/modules/services/registry.ts` | ✅ |
| S1-03 | 服务 API + 首页服务墙 + 服务详情页 + `/admin/services` 管理页 | `server/src/api/services.ts`、`modules/services/service.ts`、`web/src/pages/ServicesPage.tsx`、`ServiceDetailPage.tsx`、`AdminServicesPage.tsx` | ✅ |
| S1-04 | `Ctrl/Cmd+K` 聚合搜索（`GET /api/search`，按角色建索引） | `server/src/api/search.ts`、`web/src/components/CommandPalette.tsx` | ✅ |
| S1-05 | 三维状态分离（容器 / 可达 / 健康）+ 防 SSRF 的健康探测 | `modules/services/registry.ts`、`healthProbe.ts` | ✅ |
| 附 | 可复用 `Modal`（焦点陷阱）/ `ServiceCard` / `ServiceIcon` / `UrlCandidateList` / `ServiceForm` | `web/src/components/` | ✅ |
| 附 | 顺手修掉一个**真实运维缺陷**：WAL 模式下"只拷 `portal.sqlite`"的备份会丢数据 | `docs/static/08-operations.md` §10 | ✅ |

**没有新增任何依赖**（前端未引入图标库 / react-query / headlessui；后端未引入新包）。

---

## 2. 逐项变更

### 2.1 S1-01 服务数据模型与稳定身份

**表**（迁移 v4 `services_registry`，纯追加）：`services`（服务身份 + 展示属性 + 用户配置）、
`service_bindings`（发现结果**快照**，可丢可重算）、`service_preferences`（单例偏好 KV）。
逐列说明见 `07-data-model.md` §2。

**稳定身份**：`source_type + source_ref`，其中

| 来源 | `source_ref` 形式 |
| --- | --- |
| Compose 容器 | `docker:<compose项目>/<compose服务>` |
| 无 Compose 标签的容器 | `docker:<规范化容器名>`（剥副本后缀 `-1`/`_2`、小写、非字母数字转 `-`） |
| serve 路由 | `serve:<host>:<port><path>` |
| 手工服务 | `manual:<uuid>` |

**容器 ID 不在身份里**，只作为 `service_bindings` 的"当前关联"。
这是"容器重建换 ID 后用户配置不丢"的唯一实现方式，也是本 Sprint 最容易被写错的一点。

**自动发现与用户配置的边界（结构保证，不是纪律）**：
`ServicesRepository.updateUserFields()` 是唯一能改展示属性的入口且必然置 `user_edited = 1`；
发现流程走 `upsertDiscovered()`，其 SQL 是
`SET display_name = CASE WHEN user_edited = 0 THEN ? ELSE display_name END`（各字段同理），
**连写用户字段的能力都没有**。想交还给自动层只能显式「重置为自动」（`clearUserOverrides()`）。

### 2.2 S1-02 入口优先级、去重与规范化

- 优先级 `ENTRY_RANK`：`0` 用户指定 → `1` Serve HTTPS → `2` Tailnet → `3` LAN → `4` 仅本机。
- 去重两个键：完整 URL；`loopback:<port><path>`（解决 `127.0.0.1` 与 `localhost` 同时出现）。
- 规范化：`0.0.0.0` / `::` / `*` → 访问者主机名；默认端口（80/443）与尾斜杠省略，
  使"同一入口的两种写法"不会重复出现。
- **首选入口只从可达候选里取**（`pickEntry()`）；一个可达的都没有 → `entry: null` +
  `status.reasons` 给出原因 —— 界面宁可不给链接，也不给一个点了打不开的死链。
- **全部候选永久保留**（含不可达），详情页与卡片抽屉都能看到，这是"能解释为什么"的前提。

### 2.3 S1-03 服务 API 与界面

| 接口 | 权限 |
| --- | --- |
| `GET /api/services`（聚合，前端首页只调这一个） | viewer |
| `GET /api/services/:id`（全候选 + 诊断） | viewer（hidden → 404） |
| `POST /api/services`、`PATCH/DELETE /api/services/:id`、`POST /api/services/reorder`、`POST /api/services/discover`、`POST /api/services/:id/health` | admin（+ CSRF） |

`/api/services` 与 `/api/search` 都加入了 `api/index.ts` 的 `PROTECTED_PREFIXES`
（前缀守卫 = 登录 + CSRF），写方法在 handler 内再 `assertAdmin`。"默认安全"不变：
新增路由即使忘记加守卫，最坏是"需要登录"，不会匿名开放。

界面上有三处刻意的诚实设计：

1. **数据源降级必须透出**：`discovery.dockerAvailable` / `serveAvailable` / `serveDetail` / `notes`
   原样展示。API 模式下读不到 serve 配置时，界面说"读不到 serve 路由"，而不是"这些服务不存在"。
2. **删除语义按来源区分**：手工服务真删除；自动发现的服务只能「隐藏」或「重置为自动」——
   容器临时没起来就把用户配置删掉，是这类面板最容易犯的错。
3. **空态给下一步**：管理员看到"新建服务"入口，viewer 看到说明。

### 2.4 S1-04 聚合搜索

`GET /api/search?q=&limit=`（默认 8，上限 20）。四类内容：服务 / 容器 / 设备 / 工具。

- **只索引调用者有权查看的内容**：服务走按角色过滤的列表（非 admin 不含 hidden）；
  **设置 / 用户 / 审计 / Token 一律不进索引**（代码里连它们的数据源都不 import）。
- **搜索不产生副作用**：工具走 `probe: false`，不触发端口/HTTP 探测。
- 单个数据源失败**不会**让搜索 500（降级为该组空结果 + 一条 warn 日志）。
- 前端：全局 `Ctrl/Cmd+K`、150ms 防抖 + 递增序号丢弃过期响应、`role="combobox"` +
  `aria-activedescendant`、结果 `role="listbox"`/`option` + `aria-selected`，焦点始终留在输入框。
  Enter 行为固定：服务 → `/services/:id`、容器 → `/containers/:id`、设备 → `/devices`、
  工具 → 外部新窗口。

### 2.5 S1-05 三维状态与防 SSRF 的健康探测

**状态永远分开**：`status.container`（容器运行态）/ `status.reachable`（入口可达性）/
`status.health`（健康检查），三者独立渲染为三个状态点 + `title` 悬停解释 + `data-status`
（E2E 可断言）。代表性场景：**容器在跑但只绑 `127.0.0.1`** → `container=running`、
`reachable=false`，界面必须同时说这两件事（该去查端口映射，而不是去重启容器）。

**健康探测的授权模型**：管理员显式保存的目标 = 授权范围，但危险目标即便显式也拒绝。
默认 `skipped`（不配置就不探测）；只允许 `http`/`https`；拒绝内嵌凭据、通配地址、
云元数据（`169.254.0.0/16`、`fd00:ec2::254`、`metadata.google.internal`）、
Docker API 端口（2375/2376/2377）、unix socket 路径、超长 URL；
请求纪律：`GET`、**不跟随跳转**、3s 超时、响应体读满 16KB 即丢弃、失败不重试。
结果**只在内存**（`HEALTH_RESULT_LIMIT = 512`），进程重启即清空 —— 落库会把
"某一刻的探测结果"变成"永久的谎话"。取舍分析见 `06-security.md` §3 与残余风险第 8 条。

### 2.6 顺手修掉的真实缺陷：WAL 备份陷阱

准备迁移演练时发现：`docker cp homeport-portal:/data/portal.sqlite` 拿到的副本
**只有 v1/v2 迁移记录**，而生产库实际已是 v3。原因是数据库跑在 **WAL 模式**：
主库文件停在 `03:59`，同目录 `portal.sqlite-wal` 有 140KB，v3 迁移与近期审计全在 WAL 里。
这种"备份"能正常打开、`integrity_check` 也过，却悄悄少了几小时数据 —— 恢复后甚至会被
判定为"未迁移"而重跑迁移。**已修正 `08-operations.md` §10**：给出
方案 A（`VACUUM INTO` 一致性导出，不停机）与方案 B（停容器后整卷打包），
并给出核对项。一致性导出脚本留在仓库外的 `_homeport-backups/db-consistent-export.js`。

---

### 2.7 审查中发现并修掉的第二处真实缺陷：端口冲突时其实会"猜"归属

计划 §4 的验收清单里有一条"**多容器端口冲突不猜**"。实现完成后复核既有代码发现：
`server/src/modules/docker/mapper.ts` 的 `mapServeRoutes()` 是按
`containers.find((c) => c.ports.some((p) => p.hostPort === route.targetPort))` 归属 serve 路由的
—— **冲突时取第一个匹配容器，并不会返回 `null`**。而"两个容器报告同一宿主端口"在真实数据里
是会出现的：门户默认连**已停止**的容器一起列（`all: true`），停止的容器仍会报告自己配置过的端口绑定。

也就是说：服务层原样信任 mapper 给的 owner 时，"不猜"只是**运气好**（夹具当时把 owner 设成了 `null`，
恰好绕开了问题）。这与"sprint 1 存在的意义就是不让用户点到错的入口"直接冲突。

修法（在服务层自己判唯一性，不动既有 HTTP 契约文件）：

```ts
// registry.ts：按实时容器列表数一遍"有多少容器声称占用该宿主端口"
const claimants = countHostPortClaimants(route.targetPort);
const ambiguous = claimants > 1;   // >1 → mapper 的 owner 是猜的，否决它
```

- 归属不可信时：作为**独立 serve 服务**列出，并给出可读原因
  （"目标端口 9000 有 2 个容器同时报告占用，无法确定归属，作为独立服务列出（不做猜测）"）。
- `service_bindings` 快照里也**不记**那个不可信的 owner —— 快照是用来"下次找回关联"的，
  记错了会一路错下去。
- 用例同步改成**按真实 mapper 行为**（故意给一个 owner）断言，因此它现在是一条真正的回归测试：
  去掉守卫必然失败。`servicesDiscovery.test.ts` 23 例通过。

### 2.8 既有测试 `migrationV3.test.ts` 的必要更新（诚实记录）

追加 v4 迁移后，既有的 `migrationV3.test.ts` 变红：它硬编码断言 `MAX(version) === 2/3`。
这不是回归，而是"迁移链变长"的必然结果。改法是把断言从硬编码版本号改成
**迁移链末端**（`Math.max(...MIGRATIONS.map((m) => m.version))` 且 `>= 3`），
阶段 2 的"退回 v2 形态"同时 `DROP` v4 的三张表并 `DELETE ... WHERE version IN (3,4)`，
让**整条链**重放；v3 的专有断言（TOTP 列 / 表可用、加密值仍可读）逐条保留。
改动后这条测试比原来更严谨（v3 的存在性由列/表断言保证，而不是靠版本号等于 3）。

### 2.9 审查中发现并修掉的第三处问题：响应体上限曾经只是"声明"

归档复核时发现 `HEALTH_PROBE_MAX_BODY_BYTES = 16 * 1024` **已导出但从未被使用**：
`runHealthProbe` 实际执行的是 `await response.text()`，读的是**完整响应体**，
而 `06-security.md` 与 spec 都按设计意图写着"最多读 16KB"。

这不是笔误级别的差异：健康目标是管理员填的**任意地址**，可以是任何进程（包括一个返回
无限流的服务，或一台被入侵的机器），`response.text()` 等于让对端决定门户要分配多少内存
—— 一个 `while (true) write(...)` 就能把进程撑爆，而这正是该常量存在的唯一理由。

修法（把常量接到读取路径上）：

```ts
// healthProbe.ts
await discardProbeBody(response, HEALTH_PROBE_MAX_BODY_BYTES);
// 实现：response.body.getReader() 逐块累计到上限即 reader.cancel()（释放连接、不读完）；
//      没有流式 body 时退回一次性读取；任何异常都不影响"看状态码"这件事。
```

配套用例用**真实 `ReadableStream` 无限流**验证可区分性：新实现下 `cancel` 被调用、
读入量 ≤ 上限 + 2 个分片、50ms 内结束；旧实现会一直读到 3s 超时且 `cancel` 永不触发。
`servicesHealthProbe.test.ts` 因此从 17 例增至 19 例。

同时修正了我自己文档里三处与实现不符的地方（详见 `09-changelog.md` 已知限制第 12/13 条）：
`03-server-modules.md` 的 `listBindings` 返回类型与 `uniqueSlug` 参数、`02-configuration.md`
被删掉的一张表的分隔行（会导致该表不渲染）与缺失的 `DISCOVERY_CACHE_TTL_FALLBACK_MS`
兜底值、以及 `#service-health-target` 这条契约缺失的测试覆盖。

## 3. 数据库迁移 v4（升级前必读）

```sql
-- 迁移 v4：services_registry（纯追加，不改任何既有表）
CREATE TABLE services (...);            -- 服务身份 + 展示属性 + 用户配置
CREATE TABLE service_bindings (...);    -- 发现结果快照（ON DELETE CASCADE）
CREATE TABLE service_preferences (...); -- 单例偏好 KV
CREATE INDEX idx_service_bindings_service ON service_bindings(service_id);
CREATE INDEX idx_services_sort ON services(visibility, sort_order, display_name);
CREATE INDEX idx_services_source ON services(source_type, source_ref);
```

- **只追加**：用户、会话、偏好、设置、审计、TOTP 相关表**一列未改**，升级不改写任何既有行。
- 每个迁移在独立事务中执行并写入 `schema_migrations`；失败回滚并让启动失败（宁可起不来，不要半个 schema）。
- **回滚安全**：旧版本代码看不到这三张表也不会报错，因此镜像回滚不需要动数据库。

**真实库演练证据**（不是空库测试，而是拿生产库副本跑的）：

| 样本 | 迁移前 | 本次应用 | 结果 |
| --- | --- | --- | --- |
| `portal-pre-sprint0-….sqlite`（v2） | v1,v2 · users=2 sessions=11 audit=17 | v3,v4 | 用户/会话/审计/设置数不变、密文逐字未变、三张表建出、重复迁移幂等 ✅ |
| `portal-live-pre-sprint1.sqlite`（v3，一致性导出） | v1,v2,v3 · users=2 sessions=11 audit=17 | v4 | 同上 ✅ |

演练脚本：`_homeport-backups/migrate-rehearsal.mjs`（只读源库，复制到临时目录再迁移）。

---

## 4. 配置与接口变更

### 4.1 环境变量：**无新增**

服务发现规则、探测超时（3s）、响应体上限（16KB）、发现缓存 TTL 都是代码常量。
健康检查目标与首选入口是**按服务存库**的数据，由管理员在 `/admin/services` 保存。
最小可用配置仍然是空 `.env`。

### 4.2 新增 HTTP 接口

`GET /api/services`、`GET /api/services/:id`、`POST /api/services`、`PATCH /api/services/:id`、
`DELETE /api/services/:id`、`POST /api/services/reorder`、`POST /api/services/discover`、
`POST /api/services/:id/health`、`GET /api/search`。**未新增错误码**（沿用
`VALIDATION_FAILED` / `NOT_FOUND` / `FORBIDDEN`）。契约见 `04-api-contract.md` §6.5 / §6.6。

### 4.3 ⚠️ 对用户可见的破坏性变更：首页路径

| 路径 | 变更前 | 变更后 |
| --- | --- | --- |
| `/` | 总览（OverviewPage） | **服务墙**（ServicesPage） |
| `/overview` | —（不存在） | 总览（OverviewPage，内容一字未改） |
| `/services/:id` | —（不存在） | 服务详情（新增） |
| `/admin/services` | —（不存在） | 服务管理（新增，adminOnly） |

侧栏同时提供「服务」与「总览」两个入口，**书签指向 `/` 的用户会看到服务墙而不是总览**。
这是产品意图（首页就该是入口墙），但升级说明里必须写清。

---

## 5. 升级与回滚

完整步骤见 `08-operations.md` §7.1（含一致性备份命令、回滚标签、以及
"若手工删表必须连 `schema_migrations` 里 v4 那行一起删"的陷阱）。要点：

```bash
# 备份（一致性导出，不停机）
docker exec -e NODE_PATH=/app/node_modules homeport-portal \
  node -e "const D=require('better-sqlite3');const db=new D('/data/portal.sqlite');db.exec(\"VACUUM INTO '/tmp/snap.sqlite'\");db.close()"
docker cp homeport-portal:/tmp/snap.sqlite ./portal-pre-sprint1.sqlite

# 回滚标签 + 升级（数据卷不动，绝不要 docker compose down -v）
docker tag homeport:local homeport:pre-sprint1
docker compose stop homeport && docker compose up -d --build homeport
```

Tailscale Serve 配置（443 `/`、8443 `/calendar`、8443 `/git/`）**不需要改**：
门户只读 serve 配置，从不写它。NAS 上若服务墙提示 serve 数据源不可用，
说明当前是 **API 模式** —— serve 路由需要 `PORTAL_TAILSCALE_MODE=cli`。

---

## 6. 验收记录

| 项 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | ✅ exit 0（server + web 两个 workspace，含全部测试文件） |
| 构建 | `npm run build`（server tsc + web vite） | ✅ exit 0（73 模块，`index-*.js` 429.01 kB / gzip 128.65 kB） |
| 单测 + 集成（server） | `npx vitest run --root server` | ✅ 21 文件 / 424 用例通过（新增 5 文件 85 例；既有 16 文件全绿） |
| 单测（web） | `npx vitest run --root web` | ✅ 8 文件 / 141 用例通过（既有 4 文件 106 例无回归，无 act 警告） |
| E2E（Playwright） | `npm run test:e2e` | ✅ 9 用例通过（22.8s，无残留进程） |
| 真实库迁移演练 | `node _homeport-backups/migrate-rehearsal.mjs <v2 库> <v3 库>` | ✅ 全部通过（见 §3） |
| 实机发现验证 | `node _homeport-backups/real-discovery.mjs`（真实 Docker + `tailscale serve` CLI） | ✅ 全部通过（见下） |
| 解析性能 | `servicesDiscovery.test.ts` 的 100 服务用例 | ✅ 总耗时 < 150ms（阈值） |

### 6.1 实机发现验证（真实拓扑，非夹具）

在本机（Docker Desktop + 真实 `tailscale serve`，7 个服务）上跑完整 HTTP 栈
（`buildApp()` + 真实登录 + `app.inject()`）得到的结论：

- ✅ 家庭日历首选 **`https://sisi-laptop.tail921448.ts.net/calendar`**（Serve HTTPS），
  而不是只绑本机的端口；`localhost:443` 仍作为**不可达候选**保留并标注；
  4 条 serve 路径（`/calendar`、`/calendar.ics`、`/home`、`/api/addSchedule`）各自保留。
- ✅ 门户自身 443 `/` 归到**根域名 HTTPS**。
- ✅ 不可达服务的 `status.reasons` 给出人话（"容器端口仅绑 127.0.0.1，局域网与 tailnet 都访问不到"）。
- ✅ 多容器端口冲突的 serve 路由（`/dsh`）**不做归属猜测**，作为独立服务列出并写入 `notes`。
- ✅ 匿名访问 `GET /api/services` → 401；搜索 `calendar` → 命中服务与容器。
- ✅ 数据源可用性自洽（`dockerAvailable=true`、`serveAvailable=true`）。
- — Gitea `/git/` 与 `family-nas` 8443 `/calendar` 的用例**本机不适用**（这台开发机上没有这两个容器），
  由夹具测试覆盖该拓扑，NAS 部署时复核（已记入 `todo.md` 技术债）。

### 6.2 计划 §4 验收清单对照

| 验收要求 | 结论 |
| --- | --- |
| 日历首选 `…/calendar` 而非 `:36065/` | ✅ 实机 + 夹具双重覆盖 |
| Gitea 取 `/git/` | ✅ 夹具覆盖（本机无 Gitea，NAS 复核） |
| 门户根 443 | ✅ 实机 |
| 改名/图标/顺序在刷新与重启后不丢 | ✅ 落库（`services` 表）+ `user_edited` 保护有测试 |
| 容器重建换 ID 后关联仍可恢复 | ✅ `sourceRef` 不含容器 ID，夹具覆盖同 Compose 名新 ID |
| 0 / 1 / 20 / 100 个服务的响应时间与搜索、移动端 | ✅ 100 服务解析 < 150ms；卡片网格 1/2/3 列 |
| 空数据或 Serve 挂掉必须在 UI 里解释 | ✅ `discovery` 透出 + 降级提示（E2E 断言含 `Docker` 字样） |
| 自定义 URL 的 scheme/host 校验（拒绝 `javascript:`） | ✅ `validateHealthTarget()` 复用；有 400 测试 |
| 健康探测防 SSRF | ✅ 拒绝清单 + 零请求断言（计数注入 fetch） |

---

## 7. 风险与已知限制

1. **健康探测刻意允许 loopback 与私网**：家用场景"本机服务 + Serve 暴露"是主流形态，
   探测 loopback 是刚需；拒绝清单只覆盖"被请求就会造成危害"的目标（云元数据、Docker API 端口）。
   缓解：**默认不探测、必须管理员显式配置**。
2. **`preferredUrl` 与 `healthTarget` 共用同一套校验**（一个真相来源，避免"存得进去却探不出去"）。
   副作用：指向 Docker API 端口（2375/2376）的**链接**也会被拒。若将来确有此需求，
   需要把"链接校验"与"服务器出站校验"拆成两套并分别测试。
3. **外部图标 URL 需要 CSP 放行**：默认 `img-src 'self' data:`，`https://` 图标会被浏览器拦掉。
   管理页已提示，**不为了图标放宽默认 CSP**。
4. **API 模式读不到 serve 配置**：此时服务墙的入口会偏保守（只有端口映射）。
   界面会明确说明，不是静默少几条入口。
5. **健康结果不落库**：进程重启后回到 `unknown`。这是刻意的（结果会过期）。
6. **serve 归属不做猜测**：多容器共用同一目标端口时列为独立服务并写 `notes`，
   代价是可能多出一个服务条目，收益是绝不把入口挂到错的容器上。
7. **首页路径变更**：书签指向 `/` 的用户会看到服务墙（见 §4.3）。
8. **两个内联弹窗未迁移到新的 `Modal`**（`SecurityTab` / `UsersTab`）：无功能问题，
   仅为无障碍与去重收益，已记入技术债。

---

## 8. 未做项与下一 Sprint 前置

- **NAS 实机复核**：`family-nas` 上 443 `/`、8443 `/calendar`、8443 `/git/` 三条 serve 路由的
  服务墙呈现（开发机无法复现该拓扑）。
- **待用户决定（Sprint 0 起就一直挂着）**：接受 `trustProxy=loopback` 默认值；
  把只读 socket 代理做成 NAS 默认；E2E 是否进入发布依赖链；6 个既有前端缺陷是否本 Sprint 修。
- **服务注册表的后续增强**（本 Sprint 未做，计划里也不在 Sprint 1 范围）：
  服务分组/标签体系、批量编辑、服务级健康历史曲线、把 `service_preferences` 用到视图偏好上。
- **`git push` 仍未执行**：Sprint 0 与 Sprint 1 的提交都在本地（`origin` / `nas` 未推送）。