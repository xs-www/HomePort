# HomePort 2.0 — 均衡推进开发需求与验收规范

版本：v1.0（2026-10-16）  
项目：`xs-www/HomePort`  
执行对象：Codex / 开发代理  
目标环境：Windows 开发机 + 绿联 DX4600 Pro（8GB RAM、amd64、Docker、Tailscale）

## 0. 执行说明（交给 Codex 的总任务）

你正在维护 HomePort。请先读取项目的 `README.md`、`todo.md`、`docs/static/01-architecture.md`、`02-configuration.md`、`04-api-contract.md`、`06-security.md`、`07-data-model.md`、`08-operations.md`、`09-changelog.md` 以及实际源码和测试。**以代码为准**，文档可能落后于实际部署；先产生基线审计报告和差异清单。不得把已经实现的 `tailscale serve` 路由关联、运行时设置热更新、用户权限、基础容器监控重新当成新功能开发。

按本文件 Sprint 0 → Sprint 1 → Sprint 2 → Sprint 3 → Sprint 4 → Sprint 5 的顺序推进。每次只实施一个 Sprint；如任务超出范围，列出下一阶段提案，不顺带大改。每个 Sprint 必须提供代码、测试、迁移、文档及变更摘要；所有破坏性操作和生产部署动作需先取得操作者确认。不得读取、输出或提交真实密钥、授权码、令牌及 `.env`。

## 1. 背景、边界与成功定义

### 1.1 已具备的基线（确认后复用）

- Node.js 22 + TypeScript + Fastify 5，React + Vite，SQLite（better-sqlite3），Docker 镜像支持 `linux/amd64` 与 `linux/arm64`。
- Docker 容器只读查询、状态/端口/日志/指标、Tailnet 可达性、Tailscale CLI/API、Serve 路由发现及容器关联。
- CPU、内存、磁盘、GPU 数据源与 SSE 更新；工具端口探测、链接入口。
- `admin/viewer` 用户、bcrypt、会话、CSRF、审计日志、运行时设置（数据库覆盖 > 环境变量 > 默认值）。
- 生产事实：NAS 上 HomePort 已经通过 `https://family-nas.tail585599.ts.net/` 正常登录；`https://family-nas.tail585599.ts.net:8443/calendar` 与 `/git/` 已可访问，Serve 路由在 HomePort 容器墙中显示。Gitea 与 SisiCalendar 数据已持久化。不要修改它们的现有路由。

### 1.2 产品定义

HomePort 是**家庭 Tailnet 服务入口与只读运维可观测门户**；TsController 拥有 Tailscale Serve 配置写入职责，UGOS/Docker 专用管理端拥有容器生命周期写入职责，业务服务维护自身数据。HomePort 不主动接管这些写操作。

### 1.3 非目标

不在本周期实现 Docker `start/stop/restart/remove`、任意主机 Shell、容器终端、自动更新镜像、代理内嵌全部服务页面、完整 Kubernetes 管理、LLM 自治运维、另建 Redis/PostgreSQL/Prometheus/InfluxDB。若后续确需高权限动作，应引入独立、最小权限且可审计的操作代理。

### 1.4 全局验收门槛

1. `npm run typecheck`、`npm test`、生产构建均成功；新增接口有正向、鉴权、异常、边界测试；关键 UI 有组件测试，核心流程有 E2E 冒烟。
2. 所有写接口验证身份、角色与 CSRF；绝不把敏感环境变量、Socket、API Token 或私钥返回前端。
3. SQLite 迁移幂等，兼容旧数据；更新后保留用户、会话（除安全变更另有说明）、服务入口及设置；具有可恢复备份。
4. 镜像可在 `linux/amd64` NAS 上运行，容器健康检查通过；不修改正在工作的 Serve 443 根路由与 8443 两条业务路由。
5. 首页、容器清单、设备清单与主要操作在故障数据源下可降级展示；超时和错误可理解、不无限重试。
6. 不引入新的常驻数据库/消息队列；开发性能目标为 HomePort 稳态 RSS 尽量控制在 256MB 内，峰值需测量记录，不将其作为在未经基准环境下的绝对承诺。

## 2. 优先级、依赖与预估

| Sprint | 目标 | 优先级 | 估计 | 依赖 |
|---|---|---|---|---|
| 0 | 基线审计、安全与 CI 门禁 | P0 | 2–4 天 | 无 |
| 1 | 服务注册表与统一入口墙 | P0 | 3–6 天 | 0 |
| 2 | 轻量历史监控和诊断告警 | P1 | 4–7 天 | 0、1 |
| 3 | Tailnet 诊断和 TsController 只读集成 | P1 | 4–7 天 | 1、2 |
| 4 | 备份可观测与通知 | P1 | 4–7 天 | 2 |
| 5 | 多节点与事件自动化原型 | P2 | 7–14 天 | 1–4 |

估时仅用于排序；Codex 不应以赶进度为由跳过测试、安全审查和数据迁移。

## 3. Sprint 0 — 代码基线、安全底座、CI（P0）

### 需求

**S0-01 基线审计**：核对当前源码与 `todo.md`，列出已完成、过期描述、未完成、风险项；补充 NAS 真实部署与 Serve 集成状态。检查镜像中的运行时数据目录、Compose 卷、`docker.sock`、Tailscale socket 访问模式。

**S0-02 CI 质量门禁**：GitHub Actions PR/push 阶段运行类型检查、单元测试、构建；只有测试通过才触发构建发布；避免对外部 PR 暴露生产密钥。已有多架构 GHCR 发布保留。

**S0-03 安全补强**：引入恰当的 HTTP 安全头（CSP、HSTS 在 HTTPS 可信代理后按实际情况配置，避免破坏静态资源、SSE、登录），核对 `trustProxy` 的可信代理边界；对管理登录增加可选 TOTP（含恢复码、丢失设备流程、管理员强制重置的审计）；将敏感设置（如 API Token）使用 AES-256-GCM 加密存储，主密钥从外部环境/文件安全提供，支持旧值向新格式迁移和密钥轮换说明。不要直接把密钥写进数据库。

**S0-04 Docker 最小权限设计**：评估当前 Docker socket 风险（`:ro` 挂载不意味着 Docker API 只读）。优先支持可选只读 socket proxy，严格允许 GET API，避免暴露写操作；保证日志、inspect 不回传敏感环境变量值。该阶段不强制改动现有 NAS 部署。

**S0-05 技术债**：拆分 Docker 映射逻辑与大型 Admin 页面；补 API client、格式化、服务入口解析单测；新增 Playwright 基本流程。补上仓库 LICENSE（须由仓库所有者确认 MIT 授权，不能代替授权决定）。

### 验收标准

- CI 在含故意失败测试的 PR 上阻止镜像发布；正常分支通过全部质量门禁。
- 既有管理员与设置无损迁移；重启可正常登录；TOTP 开关和恢复码有自动测试。
- 通过抓包/响应检查，未登录和 viewer 无法访问敏感设置；token 读取默认脱敏。
- CSP 不阻断 HomePort JS/CSS、SSE、登录与现有 Serve 路由；安全头遵循代理场景，不误将内网 HTTP 标为 HSTS。
- Docker 代理模式下能读取必要资源，写接口不可用；默认原部署兼容。

## 4. Sprint 1 — 服务注册表与 HomePort 首页面板（P0）

### 问题定义

现在入口主要基于容器与端口生成，用户真正关心的是「家庭日历」「Gitea」「WorldForge」等服务，而不是容器名、`0.0.0.0:port` 或重复的 IPv4/IPv6 绑定。

### 需求

**S1-01 Service 数据模型**：新增 `services`、`service_bindings`（名称可由实现优化）和 `service_preferences`，字段至少包含稳定 id、displayName、description、icon、category、preferredUrl、sourceType、bindingRefs、visibility、sortOrder、favorites、healthTarget、created/updated；容器 ID 不可做长期唯一业务标识，优先 Docker labels/Compose service 名及服务注册规则。自动发现数据不得覆盖用户明确保存的别名/顺序。

**S1-02 入口优先级与去重**：针对同一服务按「用户指定并验证的 HTTPS 入口 > 已识别的 Tailscale Serve HTTPS > 可信 Tailnet TCP/HTTP 入口 > LAN 地址 > localhost」生成首选入口；相同容器的 `::` 与 `0.0.0.0` 映射应去重；无权访问的入口不误称可达。保留「查看所有候选入口」供诊断。

**S1-03 自定义服务管理 UI**：管理员网页内新增/编辑/删除自定义服务、名称、图标（安全 URL/内置图标）、分类、入口、健康路径；viewer 仅可看有权限的服务。首页展示收藏卡片、分类、搜索、快捷入口和健康概览，移动端可用。避免每次变动都要改 JSON 或 Compose。

**S1-04 快捷搜索**：`Ctrl/Cmd+K` 搜索服务、容器、设备、工具；只对已经有权查看的内容建立索引。支持键盘导航和可访问性标签。

**S1-05 状态语义**：服务「可访问」「容器运行」「健康检查通过」分开表示；`127.0.0.1` 宿主绑定但 Serve 可访问时，不能同时显示误导性的「仅本机不可访问」。

### 验收用例

- 日历被识别为一个服务，首选 `https://family-nas.tail585599.ts.net:8443/calendar`，不会把 `http://...:36065/` 作为首选；Gitea 选择 `/git/`；HomePort 选择根域名 443。
- 用户修改服务名称/图标/排序后刷新与重启仍保留；容器重建更换 ID 后关联仍可恢复或明确要求重新绑定。
- 对 0、1、20、100 个服务测试响应时间、搜索和移动端排版；空数据/Serve 暂失时 UI 可解释。
- 自定义 URL 严格校验 scheme/host，拒绝 `javascript:` 等危险链接；后端健康探测防 SSRF，禁止探测敏感本地管理地址（除可信明确授权范围）。

## 5. Sprint 2 — 轻量历史监控、健康与告警（P1）

### 需求

**S2-01 指标存储**：沿用现有 SSE 实时采样，增加轻量定时降采样，不为每个前端会话重复采集。建议最近 24h 每分钟聚合 1 条、最近 30 天每小时聚合 1 条；仅收集宿主 CPU/内存/磁盘、关键容器 RSS/CPU、服务健康等必要指标。SQLite 批量写、WAL、保留清理、采样失败 gap 标记。

**S2-02 历史图表**：支持 1h/24h/7d/30d 查询；标注单位、数据源、缺测与采样方式；磁盘百分比与字节不能混淆。

**S2-03 健康检测**：容器生命周期事件、Docker health 状态、HTTP 探测独立判定；要求 N 次连续失败才认定 down，恢复有去抖；可配置探测间隔且具有全局并发限制。

**S2-04 告警规则**：磁盘 >85% 持续一段时间、内存 >90% 持续 5 分钟、容器异常退出、服务连续 3 次失败等为默认禁用示例；支持在网页开启、阈值设置、静默周期、恢复通知、告警确认和审计。不得一小时内重复刷屏。

### 验收用例

- 空闲一昼夜运行后历史曲线完整，浏览器关闭后仍采集；历史数据量和 SQLite 大小被记录且符合预算。
- 重启 HomePort 后历史保留；缺测显示间断，不填 0 误导；采样不引起高 CPU。
- 假服务连续失败按规则仅发一次告警，恢复发一次恢复通知；短暂网络抖动不造成告警风暴。
- 默认配置不向外发送告警，也不自动重启容器。

## 6. Sprint 3 — Tailnet 诊断与 TsController 只读集成（P1）

### 需求

**S3-01 Tailnet 诊断页**：展示当前节点/对端设备、在线状态、最后活跃、direct/DERP 路径及不可达原因；诊断命令只能来自固定 allowlist，不允许用户输入任意 shell；对 ping/check 的频率和并发限流。

**S3-02 Serve 检查**：展示已配置的 Serve HTTPS 路由、目标、状态、重定向链和错误类别；提示路径前缀与应用 ROOT_URL 不匹配、静态资源 404、端口冲突、证书问题，但不能无证据地判断原因。

**S3-03 TsController 状态适配**：若 TsController 有受支持的只读接口，读取 `serve-routes.json` 或标准 API 与本地 Serve 实际状态进行差异比对；不直接使用 TsController 的管理会话 Cookie，不代理写操作。对外接口仅返回 HomePort 需要的最少信息。

**S3-04 服务入口联动**：将上面读取到的路由作为 Sprint 1 ServiceProvider 输入，保证设置更改后实时更新；路由消失时保留用户自定义名称并标为未同步。

### 验收用例

- 现有 `443 /` 与 `8443 /calendar`、`8443 /git/` 正确显示并关联服务。
- 断开 Tailscale CLI/Socket 时呈现明确错误，不抹除已保存服务和配置。
- Viewer 不可获取本地 Socket 位置、密钥或其他管理 API 细节。
- 诊断操作只读、低频、安全可审计；不会修改 Tailscale Serve 配置。

## 7. Sprint 4 — 备份可观测与通知渠道（P1）

### 需求

**S4-01 备份目录与状态**：配置各服务备份源（文件目录、任务日志或健康文件），只读记录最近完成时间、结果、大小、保留份数；不自行扫描 NAS 全盘。可选适配 Gitea dump、SisiCalendar SQLite 备份及 HomePort 自身备份。

**S4-02 HomePort 自身备份**：提供安全的一键导出数据库与非秘密配置清单；备份采用 SQLite 一致性备份 API 或事务快照，不生拷运行中的 WAL DB；敏感项备份必须加密或明确排除；恢复操作默认仅输出说明，执行需离线管理并备份当前状态。

**S4-03 通知**：先支持邮件（QQ SMTP 配置可复用服务商但密码须在 HomePort 独立安全保存）、Webhook（如 ntfy）两个通道；管理员在网页中填写并发送测试，支持事件级订阅、速率限制、重试退避、签名/认证与秘密脱敏。

**S4-04 备份巡检**：对「超过 24h/7d 没有成功备份」提供可配置提醒；每日汇总采用聚合告警而非每分钟提醒。

### 验收用例

- 备份源成功/缺失/权限不足分别显示正确；不会泄漏文件内容或任意路径遍历。
- HomePort SQLite 导出在重启后可恢复到隔离测试容器，账号、服务注册表及设置一致。
- SMTP/ntfy 测试消息可收到；401/超时/断网可解释、不会泄露授权码；对重复事件去重。

## 8. Sprint 5 — 多节点与自动化原型（P2）

### 需求

**S5-01 远端节点**：将 NAS、Windows/Mac/Linux 工作站定义为节点，通过受认证的只读 Agent 报送有限指标与应用服务列表；设计包含节点配对、身份轮换、授权撤销、连接状态与离线缓存。Agent 必须可以被关闭，默认不开放公网入站管理口。

**S5-02 统一设备服务视图**：按节点分组应用、资源和健康状态；保留单节点场景性能与易用性。支持同名服务的去重与来源标注。

**S5-03 事件规则引擎（只读）**：`事件 → 条件过滤 → 通知/Webhook`，预定义触发器如服务 down/recovered、磁盘阈值、备份过期和新服务发现。规则执行结果可追踪，支持 dry-run、限流、错误记录。

**S5-04 外部协作**：可选读取 Gitea 项目更新、WorldForge 健康状态或版本标识，以服务状态卡展示，不默认授予仓库写权限；统一插件清单、版本/权限说明。

### 验收用例

- 至少两节点在不同网络经 Tailnet 上报，离线有明确状态与最后时间，不把旧指标当实时值。
- 撤销 Agent 后不再接受数据；不会通过用户填入字符串执行命令。
- 规则模拟可验证，真实事件只发送允许的通知；没有任意主机命令执行能力。

## 9. 建议接口与数据模型（仅作为设计起点）

- `GET /api/services`：聚合服务列表；`GET /api/services/:id`：来源、首选入口、备选入口、健康。
- `POST/PATCH/DELETE /api/services`：管理员配置自定义服务、展示属性，不改容器或 Serve。
- `GET /api/metrics/history?range=24h&scope=host`：降采样指标。
- `GET /api/alerts`、`POST /api/alerts/rules`、`PATCH /api/alerts/rules/:id`：管理员规则。
- `GET /api/tailscale/diagnostics`：只读诊断摘要。
- `GET /api/backups/status`：备份健康概览；`POST /api/notifications/test`：管理员测试。

具体路由须与现有 `/api/*` 契约核对后命名，避免冲突。迁移表建议包含 `services`、`service_bindings`、`metrics_rollups`、`health_checks`、`alert_rules`、`alert_events`、`backup_sources`、`notification_channels`；每个版本独立事务和恢复验证。

## 10. 逐阶段交付要求（不可省略）

每个 Sprint 提交：

1. `IMPLEMENTATION_REPORT_SX.md`：完成项、跳过项、决策、与现有代码冲突及处理。
2. 测试结果：typecheck、unit、integration、E2E、build；命令、摘要和失败说明。
3. 数据迁移说明：schema 前后、备份命令、回退策略，不能以 `docker compose down -v` 作为回退。
4. 文档：更新 README、TODO、API、配置、运维手册、安全说明和变更日志中的相关部分。
5. 部署说明：基于 `ghcr.io/xs-www/homeport` 镜像的 NAS 升级步骤，使用原有持久化卷、保留 `family-nas` 的 443/8443 Serve，不默认更改 Docker/Tailscale 权限。
6. 风险清单：新引入的挂载、权限、网络入站、数据保留、密钥存储与未覆盖的测试。

## 11. Sprint 0 可直接投喂 Codex 的指令

> 在 `xs-www/HomePort` 项目中执行 **Sprint 0（基线审计 + 安全与测试底座）**。首先只读检查 README、todo、docs/static 及源码，核对已经实现的 Serve 路由集成与运行时设置，不得重复造轮子。给出基线差异和变更文件清单，再按本计划 Sprint 0 实现。禁止修改其他项目或部署中的 NAS；禁止操作生产 Tailscale Serve、Gitea、SisiCalendar 或删除 Docker 卷。所有敏感配置使用占位符，禁止输出 `.env` 密钥。完成后运行 typecheck、test、build 和新增 E2E，更新文档；给出升级/回滚方案与风险，并等待我确认后再进入 Sprint 1。

## 12. 需要人工确认的设计决策

- 是否使用 TOTP，以及现有管理员首次启用步骤；登录密钥和恢复码存储方案。
- Docker Socket Proxy 是否作为 NAS 默认部署方式（强烈建议，但先完成可用性验证）。
- 历史指标保留周期与最大磁盘预算（初始建议 30 天，具体由实际写入量决定）。
- 告警渠道优先级（邮件/ntfy），以及备份服务的具体目录授权。
- 多节点 Agent 是否单独发布 Docker 镜像；进入 Sprint 5 前再决策。

---

**最终验收定义**：从 HomePort 根域名登录，用户能看到准确、无重复的家庭服务入口；管理员能解释某个服务为什么不可达、近期是否异常、备份是否健康，并可通过最小权限的通知渠道获取必要提醒。所有新增功能在不破坏现有 Gitea、SisiCalendar、TsController 和 HomePort 持久化数据的情况下分步上线。
