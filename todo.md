# TODO

> 最后更新：2026-10-17

## 已完成 ✅

### 基础设施
- [x] npm workspaces 单仓库（`server` / `web`），TypeScript 5.9 strict 模式
- [x] 统一配置层 `server/src/config.ts`（唯一 `process.env` 读取点，非法值启动即报错）
- [x] 结构化日志（不引入 pino）
- [x] SQLite + 迁移框架（版本化、独立事务、失败回滚）
- [x] 统一错误契约 `{ error: { code, message, details } }`
- [x] `.gitattributes` 统一换行符

### F0 服务墙 / 服务注册表（Sprint 1）
- [x] 迁移 **v4 `services_registry`**：`services` / `service_bindings` / `service_preferences`
      （纯追加，既有表一列未改；真实库演练 v2→v4、v3→v4 均通过且幂等）
- [x] **稳定服务身份**：`source_type + source_ref`（`docker:<compose项目>/<compose服务>` /
      规范化容器名 / `serve:<host>:<port><path>` / `manual:<uuid>`），**不含容器 ID** ——
      容器重建换 ID 后用户配置仍能挂回同一服务
- [x] **自动发现不得覆盖用户配置**：`upsertDiscovered()` 的 SQL 用
      `CASE WHEN user_edited = 0` 保护用户值；`updateUserFields()` 是唯一能改展示属性的入口
- [x] **发现与合并**：容器端口 + `tailscale serve` 路由（路径级）归并成服务；
      serve 归属优先用 `targetPort` + 容器名匹配，多容器冲突**不猜**（作为独立服务并写进 notes）
- [x] **入口优先级与去重（S1-02）**：用户指定 0 > Serve HTTPS 1 > Tailnet 2 > LAN 3 > 仅本机 4；
      `127.0.0.1`/`localhost` 与 `0.0.0.0`/`::` 去重；默认端口与尾斜杠规范化；
      **保留全部候选入口**（含不可达）供诊断
- [x] **首选入口只从可达候选里取**；一个可达的都没有 → `entry: null` 并给出原因，不给死链
- [x] **三维状态分离（S1-05）**：`status.container`（容器运行）/ `status.reachable`（入口可达）/
      `status.health`（健康检查）各自独立，永远不合并成"服务挂了"；`reasons[]` 给人话解释
- [x] **健康探测防 SSRF（S1-05）**：默认 `skipped` 不探测；只允许 http/https、拒绝内嵌凭据 /
      通配地址 / 云元数据 / link-local / Docker API 端口(2375-2377) / unix socket；
      不跟随跳转、3s 超时、响应体截断 16KB、结果只在内存不落库
- [x] **API（S1-03）**：`GET/POST/PATCH/DELETE /api/services*`、`POST /api/services/reorder|discover`、
      `POST /api/services/:id/health`；写操作 admin + CSRF，viewer 只读且看不到 hidden
- [x] **聚合搜索（S1-04）**：`GET /api/search`，服务/容器/设备/工具四类，
      **只索引调用者有权查看的内容**（设置/用户/审计/Token 不进索引），工具走 `probe:false` 无副作用
- [x] **首页服务墙**（`/`，原总览迁到 `/overview`）：收藏区 + 分类分组 + 卡片网格（移动端 1 列 / ≥640px 2 列 / ≥1024px 3 列）、
      搜索入口、数据源降级提示（`discovery` 必须透出，不静默为空）、空态引导
- [x] **服务详情页** `/services/:id`：全部候选入口（含不可达）+ `status.reasons` + 诊断
      （容器端口 / serve 路由 / notes）——"为什么这个服务不可达"必须查得到
- [x] **服务管理页** `/admin/services`：排序、收藏、可见性、编辑、新建、重新发现、健康探测；
      删除语义按来源区分（手工=删除，自动=隐藏，另有"重置为自动"）
- [x] **`Ctrl/Cmd+K` 命令面板**：全局唤起、防抖 + 竞态保护、`role="combobox"`/`listbox`/`option` +
      `aria-activedescendant`、↑↓/Enter/Esc 键盘操作
- [x] **可复用组件**：`Modal`（焦点陷阱 + 归还焦点 + Esc/遮罩关闭）、`ServiceCard`、`ServiceIcon`、
      `UrlCandidateList`、`ServiceForm`
- [x] **测试**：服务发现/入口优先级/三维状态/100 服务性能、健康探测 SSRF、API 鉴权与 hidden 过滤、
      迁移 v4 数据无损、搜索按角色过滤、前端组件与命令面板、E2E（服务墙降级提示 + 手工服务持久化 +
      Ctrl+K 进详情 + viewer 管理边界）
- [x] **真实库迁移演练**：用生产库副本（v2 与 v3 各一份）跑 v4，用户/会话/审计/密文逐字不变、幂等
- [x] **实机发现验证**：真实 Docker + 真实 `tailscale serve` 下，日历首选 `/calendar`、
      门户 443 归根域名、不可达候选保留并标注、诊断数据完整

### F1 容器入口墙
- [x] Docker 只读数据源（dockerode；**类型层面不存在写方法**）
- [x] endpoint 解析：npipe / unix / tcp / http / https（含 named pipe 归一化）
- [x] 容器列表（list + 有限并发 inspect，8 路并发）
- [x] **tailnet 可达性判定**：按宿主端口绑定地址分类
- [x] **`tailscale serve` 路由**：路径级反向代理单独成源，修复"只看端口映射会漏掉
      只绑 127.0.0.1 但经 serve 暴露的服务"这个判定盲区（`serveProvider.ts`）
- [x] **修复 `withSocket()` 参数位置**：`--socket` 是全局 flag，必须在子命令之前
      （Linux/NAS 上显式配置 socket 时会直接失效）
- [x] 入口 URL 生成：两层设计（缓存算可达性，响应阶段按访问者算 URL）
- [x] 多候选入口（tailnet IP / MagicDNS / localhost）
- [x] 容器详情：实时占用、端口表、挂载、脱敏环境变量、日志
- [x] tailscale sidecar 识别（`TS_*` 环境变量或镜像名）

### F2 tailnet 设备
- [x] CLI 数据源（`tailscale status --json`）
- [x] REST API 数据源（`/api/v2/tailnet/-/devices`）
- [x] `auto` 策略自动选择
- [x] 设备映射（在线状态、OS、IP、直连/中继、最后可见、流量）
- [x] 单向寄存器解开 `docker ↔ tailscale` 模块环
- [x] 数据源失败时保留上次地址（避免整面容器墙误判不可达）

### F3 系统指标
- [x] 宿主 `/proc` 读取（CPU/内存/负载/运行时长/CPU 型号）
- [x] `os.cpus()` 兜底（用于无 `/proc` 的环境）
      **实测修正**：该路径在 **Windows 容器化** 下只能看到 WSL2 虚拟机资源
      （4 线程 / 3.9 GB），不是 Windows 真实值；要拿真实值需原生运行。见 `08-operations.md` §2
- [x] 采样间隔保护（避免 CPU 读数抖动）
- [x] 磁盘 `statfs`（可配多挂载点）
- [x] GPU：`nvidia-smi` 多字段查询 + 占用进程 + WSL 库路径支持
- [x] 数据源模式标注（`host-proc` / `os-cpus` / `container-proc` / …）
- [x] SSE 实时推送（心跳、最长存活、自动重连）

### F4 工具入口
- [x] 内置目录 8 个（Ollama / DSH / ComfyUI / Open WebUI / Portainer / Jellyfin / qBittorrent / code-server）
- [x] JSON 文件覆盖（按 id 合并或整体替换）
- [x] `PORTAL_TOOLS_EXTRA` 环境变量追加
- [x] 两级探测（TCP → HTTP）+ TTL 缓存 + 后台刷新（stale-while-revalidate）
- [x] 多候选入口 + 单工具强制重探

### F5 登录权限
- [x] bcrypt cost 12 + 密码强度校验
- [x] 会话令牌（DB 只存 SHA-256）+ httpOnly Cookie
- [x] CSRF 独立令牌 + 请求头校验
- [x] 首启初始化（令牌来自环境变量 / 文件 / 日志）
- [x] 角色守卫（admin / viewer）+ "最后一个管理员"保护
- [x] 用户管理：增删改、重置密码、强制下线
- [x] 审计日志（16 种动作）+ 90 天清理
- [x] 登录限流 10 次/分钟/IP
- [x] 用户枚举防护（统一报错 + 耗时抹平）
- [x] 自助改密（保留当前会话，吊销其它）
- [x] **两步验证 TOTP（S0-03，服务端）**：纯函数核心 `modules/auth/totp.ts`（RFC 6238，
      兼容 HMAC-SHA1/6 位/30 秒）、恢复码与登录挑战仓储 `db/totp.ts`（`TOTP_CHALLENGE_MAX_ATTEMPTS=5`）、
      迁移 v3（`users.totp_secret/totp_enabled/totp_confirmed_at/totp_last_counter` +
      `totp_recovery_codes` + `totp_challenges`）；密码通过后**不签发会话**、只给挑战令牌，
      两个登录接口共用限流；防重放 `totp_last_counter` **只作用于登录路径**（有意取舍）；
      恢复码 10 个 `XXXX-XXXX`（剔除 `0O1IL`）只存 sha256 摘要、一次性核销；
      管理员强制重置（清绑定 + 吊销全部会话 + 审计）；前端同批交付（见下）

### F6 运行时设置（界面内改配置，免重建容器）
- [x] 迁移 v2 `settings` 表 + `SettingsRepository`
- [x] 三层优先级：数据库覆盖 > 环境变量 > 内置默认
- [x] 28 项设置的注册表（分组 / 生效级别 / 类型 / 范围 / 敏感标记）
- [x] 三级生效语义：`live` / `reload`（自动重建数据源）/ `restart`（拒绝写入）
- [x] 热重建：Tailscale 数据源、Docker 连接、容器缓存 TTL、/proc 读取器
- [x] `GET/PATCH /api/settings`、`POST /api/settings/reset`
- [x] `POST /api/settings/test/tailscale`：**先测再存**，401/403/超时给出可操作提示
- [x] 敏感值打码读取、占位符写入 = 不修改、审计只记键名
- [x] **敏感设置加密存储（S0-03）**：注册表标 `sensitive` 的键 AES-256-GCM 落库
      （`enc:v1:` 密文）、读出解密；旧明文照常可读并在下次写入时自动升级，
      首启 `reencryptAll()` 一次性升级存量（幂等、返回条数）；
      `previousKeys` 支持密钥轮换；解密失败降级为「未设置」且不崩进程；
      非敏感键保持明文；日志/审计只记键名（`secretStore.ts`）
- [x] 前端「账号管理 → 系统设置」面板：分组展示 + 生效级别徽标 + 来源徽标 + 测试连接
- [x] 明确标注硬边界（需重建容器的项不给编辑控件）

### F7 历史趋势 / 健康监测 / 告警（Sprint 2）
- [x] 迁移 **v5 `metrics_alerts_schema`**：`metric_buckets` / `alert_rules` / `alert_events`
      （纯追加，v1–v4 一列未动；真实库**副本**演练 v4→v5、v3→v4→v5 均 15/15 通过，
      用户/会话/审计/设置数不变、密文逐字不变、新表为空、重复迁移 0 个）
- [x] **后台单例降采样**：最近 24h 每分钟 1 条、最近 30d 每小时 1 条；宿主 CPU/内存/磁盘 +
      关键容器 RSS/CPU + 服务健康。**不是每个前端会话采一份** —— `backgroundJobs` 只控制定时器，
      采样器始终构造，**零浏览器连接时 `tickOnce()` 照样写库**（用零 SSE/HTTP 客户端验证）
- [x] **缺测不写 0**：缺的分钟是"没有行"，`samples < expected` 才标 `partial`；采样中断该段无行
      并计入 `gaps`（图上"没数据"与"真的是 0"必须能分开，否则会误导判断）
- [x] **批量写 + WAL + 保留清理 + 预算**：写事务数与 **tick 密度无关**（30s 与 5s 间隔同样时长
      写事务数相同 = 1861）、整点那一次 tick 恰好 2 次批量写（flush + rollup）；
      库大小按 `page_count × page_size` 报出；稳态上限 32 MB，`storage()` 给出 `withinBudget`
- [x] **历史查询与图表**：1h/24h/7d/30d（分钟/小时两分辨率）；空窗口 `summary` 的
      `avg/min/max/latest` 是 `null` 而**不是 0**；**磁盘百分比与磁盘字节永不混算**；
      图表标注单位、数据来源、缺测与聚合方式
- [x] **健康检查（S2-03）**：容器生命周期 + Docker health + 独立 HTTP 探测三维独立计数
      （连续 N 次失败才 `down`、恢复需连续 2 次全好、抖动清零、`unknown` 不清零也不推进）；
      可配探测间隔与**全局并发上限**；探测失败只判 http 维、不清空既有状态
- [x] **告警（S2-04）**：四条内置示例规则**默认关闭**（装了但不吵），界面可开关/改阈值/静默期；
      episode 模型（同一规则同一目标最多一行未恢复，用部分唯一索引保证）+ 恢复通知 + 确认与审计；
      **一小时内不重复刷屏**（静默期内重开同一行 `reopen_count+1`）
- [x] **"后台模块无出站能力"是可执行约束而非注释**：`backgroundBoundary.test.ts` 扫描
      `modules/metrics|health|alerts` 与 `backgroundContext.ts`，断言无
      `fetch`/`http(s).request`/`net.connect`/`child_process`/`nodemailer|axios|node-fetch|undici`/
      直连 `docker.sock`，且 `healthProbe.ts` 只发 `GET` 无请求体
      （Sprint 2 不做外发通知、不自动修复；通知渠道到 Sprint 4）
- [x] **装配层缺口由端到端用例抓出并验证判别力**：告警引擎若未接 `createAlertSnapshotSource`，
      四条规则永远 `evaluated = 0` —— 36 条单测全绿但**生产上静默失效**。
      `schedulerIntegration.test.ts` 现在断言完整因果链（触发 1 条 → 故障期不重复 →
      恢复写回同一行 → 静默期内重开不新增 → 三个审计动作齐全），
      并用"只撤掉那一行接线"实测过它确实会红
- [x] **新增 6 项可热改设置**：`PORTAL_METRICS_SAMPLE_INTERVAL_SEC` /
      `PORTAL_METRICS_RETENTION_MINUTE_HOURS` / `PORTAL_METRICS_RETENTION_HOUR_DAYS` /
      `PORTAL_METRICS_CONTAINER_LIMIT` / `PORTAL_HEALTH_PROBE_INTERVAL_SEC` /
      `PORTAL_HEALTH_PROBE_CONCURRENCY`（全部 `effect: 'live'`）
- [x] 顺带修掉两个真缺陷：设置分组 `groupList()` 手抄副本漏了 metrics/health（导致设置页少渲染 6 个键）；
      `ContainerSummary` 未映射 `State.ExitCode`（导致"容器异常退出"规则名不副实，只有 `dead` 能触发）

#### Sprint 2 验收驳回修复（三个 P1，已修；归档时又发现并收口**同类第三处：告警读接口**；改动见 `09-changelog.md`）

- [x] **P1-1 健康监视器泄漏隐藏服务**：`if (tracked.length > 0) dropStaleStates(...)` 让"**成功读到空列表**"
      （= 用户把服务全隐藏/全删）永不 reconcile，旧状态与**旧服务名**永久留在
      `GET /api/health/monitor`。修法：`loadServices()` 返回带 `ok` 判别位的 `ServiceListViewResult`
      （`list()` 抛错 / 响应缺 `items` = 读失败；正常返回**含空 `items`** = 读成功）——
      **不靠"数组是否为空"事后猜**；`loaded.ok` 时（**空列表也**）更新可见集合并
      `dropStaleStates()`，且**同时删 `labelsByRef`**（名字与状态同生同灭）；读失败时旧状态与
      `visibleRefs` 原样保留、原因进 `view().notes`。另加**读路径纵深防御**
      （`visibleRefs` + `isVisible()`，`states()` / `state()` / `view()` 都过滤；
      `null` = 还没成功读过则不过滤）。**语义收紧**：`state(ref)` 对不可见 ref 返回 `null`。
      回归 4 条（`healthMonitor.test.ts`，现 21 条），含"绕过 `dropStaleStates` 直接塞回不可见状态"的
      可区分性用例
- [x] **P1-2 历史指标读接口绕过当前可见性**：采集侧固定 viewer 只保证"隐藏之后不再新增样本"，
      **隐藏之前**已落库的行与进程内 `liveTargets` 仍带着服务名 → catalog 列出、history 查得到，
      直到历史过期。修法：新增 `visibleServiceRefs()`（与采集同一个 `backgroundHostRequest(config)`，
      **刻意不缓存 —— 注释写明"任何 TTL 都是泄漏窗口"**）、`isHostOwnedTarget()`、`targetVisible()`；
      `availableTargets()` / `resolveTarget()` / `catalog()` 改 async 并按**当前**可见性过滤；
      注册表读失败 **fail-closed**（服务/容器类 target 一律不可见，宿主/磁盘不受影响）；
      `resolveTarget()` 在**任何存在性查找之前**先过可见性 → "被隐藏"与"从未采集过"返回**同一条**
      400 `VALIDATION_FAILED` + `targetPattern`（**没有** 404/403，也没有任何区分字段）。
      回归 13 条（新增 `metricsVisibility.test.ts`，全走 `buildApp()` + `app.inject()` 真实路由与鉴权，
      夹具是真的采集；判别力实测：临时关掉过滤 → 6 条变红）
- [x] **P1-3 服务端测试依赖墙钟**：`schedulerIntegration.test.ts` 原
      `BASE = minuteStart(Date.now()/1000) - 3600` **必然横跨一个整点**（实测 `10 === 5`）；
      `metricsApi.test.ts` 用 `Date.now()` 取 T0 并用墙钟推导保留截止时刻。修法：两条线改用**固定 epoch
      `1_700_000_000`**（`BASE = hourStart(EPOCH) + 15min`；`vi.setSystemTime`）+
      **三个数据源全部换成注入假夹具**（序列数因此是确定值，断言从区间收紧为等号），
      每个"本该没有 hour 行"的地方显式断言 `hoursRolledUp === 0`，并**新增跨整点用例**
      （22:59:30 → 23:00:30）。另新增守卫 `clockBoundary.test.ts`（4 条）：扫源码禁止这两个文件出现
      `Date.now(` / `new Date(` / `performance.now(`，要求同一个 `EPOCH` 与三个注入点，
      文件缺失或为空时必须失败

### 前端
- [x] React 19 + Vite 6 + Tailwind 4 + React Router 7
- [x] 类型化 API 客户端（CSRF 自动注入、401 回调、超时）
- [x] 会话 Context（含主题防闪白、偏好同步）
- [x] 12 个 UI 原子组件（含内联 SVG 图标集）
- [x] 侧边栏布局（桌面固定 / 移动抽屉）
- [x] 7 个页面 + 404
- [x] 路由守卫（登录态、初始化态、管理员）
- [x] SSE 指标流订阅
- [x] 暗色/亮色/跟随系统三态主题

### 容器化与文档
- [x] 四阶段 Dockerfile（alpine、非 root、tini、healthcheck）
- [x] `docker-compose.yml`（Windows 与 NAS 同一份）
- [x] **容器最小权限（S0-04）**：`docker.sock` 改为 **`:ro`** 挂载，新增
      `cap_drop: ALL` 与 `no-new-privileges:true`；**去掉**硬编码的 Windows `C:/` 磁盘挂载
      （默认全部注释，需要时显式启用并同步 `PORTAL_DISK_MOUNTS`）；
      另提供**可选**的只读 socket 代理覆盖文件 `docker-compose.socket-proxy.yml`
      （只放行 CONTAINERS/INFO/VERSION/PING，不 publish 到宿主）——
      **代理仍是可选增强，不是默认部署方式**
- [x] `.env.example`（含分平台部署矩阵）
- [x] `docs/static/` 9 个静态文档
- [x] `README.md`
- [x] 单测：`npm test` 覆盖 `server` 与 `web` 两个工作区（Vitest），
      另有 Playwright E2E 冒烟 `npm run test:e2e`
- [x] 真实环境实测（Docker + Tailscale + 硬件，逐项交叉验证）

### 品牌与命名
- [x] 产品定名 **HomePort（母港）**：`port` 双关"端口/港口"，与 F1 的端口可达性判定名副其实
- [x] 包名统一：`homeport` / `@homeport/server` / `@homeport/web`（含 `package-lock.json`）
- [x] 容器侧改名：service `homeport`、image `homeport:local`、container `homeport-portal`、volume `homeport-data`
- [x] 界面与文档改称（页面标题 / 侧边栏 / 登录页 / 兜底页 / README / 静态文档）
- [x] **决定不改**：环境变量前缀 `PORTAL_*`、会话 Cookie `hp_session`、DB 文件 `portal.sqlite`、
      仓库目录 `HomePage/` —— 只改"名字"，不动配置键，避免 `.env` 与既有部署失效
- [x] **部署侧迁移已执行并实测通过**：先建新镜像（旧容器继续服务）→ `docker stop` 合并 WAL
      → `docker volume create homeport-data` + `cp -a` 迁数据 → `up -d --remove-orphans`
      清掉旧容器。实测账号/会话/偏好全部保留，`homeport-portal` `Up (healthy)`
- [x] 推送公开仓库前清除历史中的明文 admin 密码（工作区打码 + `filter-branch` 重写历史）
- [x] 已推送至 `https://github.com/xs-www/HomePort.git`（分支 `master`，首推提交 `37f27e0`）
- [ ] 数据卷 `homeport-data` 缺 Compose 归属标签，每次 `up` 会打印一条无害告警（有意保留，见 changelog）
- [ ] **建议轮换 admin 密码**：原明文曾进入 git 历史（现已清除）与本机磁盘，按安全惯例应视为已暴露

## 待办

### 高优先级（影响可用性）

- [x] **镜像构建实测**：Windows Docker Desktop 上 `docker compose up -d --build`
      首次即成功，容器 `Up (healthy)`，五个数据源状态符合预期（2026-10-16）
- [x] **工具探测目标主机 bug**：容器内 `localhost` 指向容器自己，导致 8 个工具全报不可用。
      已改为多目标链（对外主机 → `host.docker.internal` → `127.0.0.1`）并重新验证（2026-10-16）
- [ ] **Windows 上读取 serve 路由**：容器化下读不到（无法执行 `tailscale.exe`，
      tailscaled 走 named pipe，REST API 也不提供 serve 配置）。
      可选方案：让 TsController 暴露本地 HTTP 接口，门户作为 host-agent 读取。
      `ServeRoutesProvider` 是注入式接口，换实现即可，无需改容器模块
- [x] **多架构镜像构建实测**：本机 `docker buildx build --platform linux/arm64` 通过
      （2026-10-16），`better-sqlite3` 在 QEMU 下从源码编译成功（约 77s）；
      CI 当前按 `linux/amd64,linux/arm64` 产出多架构 manifest list
- [ ] **Windows 宿主真实硬件指标**：容器化部署只能看到 WSL2 虚拟机资源。
      可选方案：
      1. 补充「原生运行」的部署文档与一键启动脚本（推荐，实测可行）
      2. 增加 Windows 专用 GPU provider：容器内无法执行 `nvidia-smi.exe`，
         若坚持容器化则只能放弃 GPU 指标
      3. 在 UI 上检测到"WSL2 视图"时主动提示用户可改用原生运行
- [ ] **检测 WSL2 视图并提示**：目前 `os-cpus` 模式下无法区分
      "macOS 原生（真实值）"与"Windows 容器（WSL2 视图）"。
      可用 `cgroup` CPU 配额与 `os.cpus().length` 的差异做启发式判断
- [ ] **Windows tailnet 查询体验**：需要手动切 `PORTAL_TAILSCALE_MODE=api` 并填 Token。
      可在检测到 CLI 不可用时于设备页直接给出可点击的管理后台链接
- [ ] **首次部署引导页**：`/api/health` 已能报告各数据源问题，
      可在总览页把 warnings 变成"点这里看怎么修"的可展开清单

### 中优先级（增强）

- [x] **敏感项加密存储**：API Token 等在数据库中已是 AES-256-GCM 密文
      （`secretStore.ts`；主密钥来自 `PORTAL_SECRET_KEY` 或 `<dataDir>/secret.key`）。
      见 `06-security.md` §7
- [ ] **工具目录可视化编辑**：现在只能填 JSON 文件路径，不能增删改单条工具
- [ ] **设置并发冲突检测**：两个管理员同时改会后者覆盖前者。可用 `updated_at` 做乐观锁
- [x] **TOTP 二次验证（前端部分，S0-03）**：登录第二步（`totpRequired` → `/api/auth/login/totp`）、
      自助绑定 / 一次性恢复码 / 重新生成 / 关闭（`SecurityTab`）、管理员强制重置（`UsersTab`）、
      `web/tests/totp.test.tsx` 14 个用例；`challengeToken` 只存组件状态、不落 Web Storage。
      后端接口同批实现（`server/src/modules/auth/totp.ts`）；契约差异见 `09-changelog.md` S0-03 前端一节
- [x] **TOTP 收尾**：二维码展示已决定**不**引入二维码库（用密钥文本 + `otpauth://` 链接替代，
      文案里已说明）；唯一管理员丢失设备的离线重置流程已归档到 `08-operations.md` §5
      （管理员强制重置 + `docker compose exec` 改库两条路径，含可直接执行的 SQL 与列含义）
- [x] **安全响应头（S0-03）**：**未引入** `@fastify/helmet`，改为手写
      `server/src/http/securityHeaders.ts` —— 理由：需要精确控制 HSTS 的 HTTPS 判定
      （只在确为 HTTPS 时下发，且不带 `includeSubDomains`，宿主是共享域名）与 SSE 分支，
      同时少一个运行时依赖。默认 CSP（`DEFAULT_CSP`，`PORTAL_CSP` 可覆盖）+ 六个固定头，
      `/api/*` 加 `cache-control: no-store`；SSE 端点手动补头
      （`reply.raw.writeHead` 绕过 `onRequest` 钩子）；E2E 有对应断言。
      见 `06-security.md` §8
- [ ] **CSP 违规上报**：目前没有 `report-uri` / `report-to`，策略改严后违规是静默的
- [ ] **容器 list 性能**：容器数 >50 时，list+inspect 的耗时可能超过缓存 TTL。
      可改为增量：先 list 比对 ID，只对新容器 inspect
- [x] **历史趋势图（Sprint 2 已做，方案比原计划更稳）**：没有采用"内存环形缓冲区"（重启即丢），
      改为 SQLite 降采样落库（24h 每分钟 / 30d 每小时）+ 保留清理 + 预算约束，
      所以重启后曲线还在、磁盘占用也有上界（原计划"不落盘"的顾虑由保留窗口与 32 MB 预算解决）
- [ ] **tailscale serve 集成**：对通过 `tailscale serve` 暴露的服务，
      读取 serve 配置以生成准确的入口 URL（当前只识别 sidecar 并打 badge）
- [ ] **通知**：容器退出、磁盘将满、登录失败次数异常时推送（可选 webhook / ntfy）
- [ ] **i18n**：当前硬编码中文，可抽出词条支持英文

### 低优先级（可选）

- [ ] 容器写操作（start/stop/restart）——**需先重新评估威胁模型**，
      见 `06-security.md` §9.5。若要做，建议独立角色 `operator` 并强制二次确认
- [ ] 反向代理模式：内嵌其它 Web 应用（而非跳转）。需要处理 base path、
      WebSocket、Cookie 域、CSP，维护成本高，见 `01-architecture.md` §6
- [ ] 主题自定义色板
- [ ] 导出审计日志为 CSV
- [ ] 支持 PostgreSQL（当前 SQLite 足够，仅在多实例部署时才有必要）
- [x] **补 `LICENSE` 文件**：已加根 `LICENSE`（MIT，Copyright (c) 2026 xs-www），
      与 `package.json`/各工作区的 `"license": "MIT"` 一致
- [x] CI：GitHub Actions 构建多架构（amd64 + arm64）镜像并推送 GHCR（`ghcr.io/xs-www/homeport`）

## 技术债

- [ ] **`e2e/**` 完全不在类型检查内**：`npm run typecheck` 只跑 `server` + `web` 两个工作区，
  Playwright 用例是运行期转译（不做类型检查）。代价是 E2E 里的类型/属性笔误只能在跑测试时暴露
  —— Sprint 1 就真的踩过一次（`getByRole('textbox')` 写成不存在的角色，`typecheck` 毫无反应）。
  修法：给 `e2e/` 加一个 `tsconfig.json`（`types: ['node']` + 引用 `@playwright/test`）并纳入
  `npm run typecheck`。**没有立刻做**是因为 e2e 从未被类型检查过，首次纳入可能一次性冒出若干
  既有报错，属于独立改动，不想混进 Sprint 2 的提交里。
- [ ] **函数级静态文档重建（方案已定，待执行）**：用 `code-static-documentation` 技能包为
  `server/src`（73）+ `web/src`（39）+ 配置文件（13）共约 **125 篇**函数级文档，输出到
  **`docs/static/code/**`**（镜像源码目录；保留现有 01–09 契约文档，并把这些文档里那种
  "汇总表"式描述与逐函数文档分工：01–09 讲架构与契约，`code/**` 讲每个函数的签名与边界）。
  **时机：Sprint 2 提交之后** —— 技能本身要求版本稳定期执行（每篇文档头要写 commit hash），
  且需等三条并行开发线的文件全部落地。
- [x] `server/src/modules/docker/service.ts` 映射逻辑已拆到 `mapper.ts`（S0-05）：
      700 → 370 行（只留缓存/数据源/契约装配），纯函数层 430 行；
      `service.ts` 保留全部同名 re-export；新增 `server/tests/dockerMapper.test.ts`（24 个入口解析用例）。
      顺带修掉双栈绑定的重复入口（真实 inspect 里 `0.0.0.0` 与 `::` 同端口会出现两条一样的入口，
      去重抽成独立纯函数 `dedupeIdenticalBindings`）
- [x] `web/src/pages/AdminPage.tsx` 已拆分（S0-05）：655 → 89 行，只保留路由级取数、
      标签页骨架与 props 分发；三个标签页各自成文件 ——
      `web/src/pages/admin/UsersTab.tsx`、`AuditTab.tsx`、`SecurityTab.tsx`
      （`SettingsPanel.tsx` 原已独立）
- [x] 前端已补测试：`web/tests/` 下 `client.test.ts`（CSRF 注入、错误转换、401 语义）、
      `format.test.ts`、`components.test.tsx`、`totp.test.tsx`（两步登录与自助管理）；
      `web/vitest.config.ts` 提供 jsdom + RTL 环境，根 `npm test` 会同时跑 server 与 web
- [ ] `TtlCache` 的 `evictIfNeeded` 每次都全量遍历，条目数大时是 O(n)。
      当前 maxEntries=200，暂不构成问题
- [x] E2E 已补（Playwright）：`e2e/smoke.spec.ts` + `e2e/security-headers.spec.ts` +
      `e2e/start-server.mjs` + `playwright.config.ts`；覆盖首启初始化 → 登录/登出 →
      关键页面降级提示 → 权限边界 → 安全响应头。默认端口 8988（`PORTAL_E2E_PORT` 可覆盖），
      启动前跑完整生产构建、每次清空 `.e2e-data`。见 `08-operations.md` §12
- [x] 测试的宿主依赖性已收口：`tailnet 连通性`用例改为自钉模式与 Token
      （原先会读前一个用例写下的 Token / 依赖本机是否装了 Tailscale CLI，CI 与本机分支不同）；
      `auth.test.ts` 增加环境变量清理，与 `settings.test.ts` 既有约定一致
- [x] 环境变量边界变成可执行约定：`config.envVars` 快照 + `config.readEnvVar()`，
      其余模块不再直接读 `process.env`（`registry.ts` / `tailscale/provider.ts` /
      `system/provider.ts` / `util/exec.ts` / `tailscaleProbe.ts` 均已改）；
      `server/tests/envBoundary.test.ts` 扫描源码钉住这一点
- [x] CI 已覆盖测试（S0-02）：新增 `.github/workflows/ci.yml`（PR 与 master push：
      typecheck + 单测 + 构建 + E2E，**无 paths-ignore**）；
      `docker-publish.yml` 新增 `quality` job 且 `build-and-push` 依赖它。
      **注意**：E2E 不是发布前置 —— `build-and-push` 只依赖同文件的 `quality`；
      要让它卡住发布需在该文件里也定义 `e2e` job 并把依赖写成 `needs: [quality, e2e]`
      （`needs` 不能跨工作流引用）

- [x] **备份方式修正（Sprint 1 实测发现）**：`portal.sqlite` 跑在 **WAL 模式**，
      只拷主文件的"备份"会静默丢掉未 checkpoint 的写入（实测主库停在 03:59、`-wal` 有 140KB，
      v3 迁移与近期审计全在 WAL 里）。`08-operations.md` §10 已改成
      方案 A（`VACUUM INTO` 一致性导出，不停机）+ 方案 B（停容器后整卷打包），
      并给出核对项（`schema_migrations` / 条数 / `integrity_check`）
- [ ] 两个内联弹窗（`pages/admin/SecurityTab.tsx` / `UsersTab.tsx`）尚未迁移到新的
      `components/Modal.tsx`（Sprint 1 新建，带焦点陷阱与焦点归还）。当前无功能问题，
      迁移收益是无障碍一致性 + 少两份重复实现
- [ ] 服务注册表的**外部图标 URL** 需要 `PORTAL_CSP` 的 `img-src` 放行对应来源才能显示
      （默认 CSP 是 `img-src 'self' data:`）。**不为了图标放宽默认 CSP** —— 管理页已提示这一点
- [ ] Gitea `/git/` 与 `family-nas` 8443 `/calendar` 的验收用例在 NAS 上复核
      （开发机上没有这两个容器；夹具测试 `servicesDiscovery.test.ts` 已覆盖该拓扑）
- [x] **服务墙移动视口 E2E（Sprint 1 验收缺口，已补）**：`e2e/smoke.spec.ts` 末尾新增
      390×844 视口用例，断言网格单列、卡片不溢出视口、页面无横向滚动、命令面板不溢出且可用。
      仍未覆盖的是"超长服务名截断"的视觉细节（要做需要视觉回归工具，暂不引入）
- [ ] `mapper.mapServeRoutes` 仍按 `containers.find(...)` **取第一个匹配容器**（端口冲突时），
      既有契约未改；服务层已加"归属唯一性守卫"（`countHostPortClaimants`）兜住它。
      彻底修法是让 mapper 在冲突时返回 `null`，但那会改动既有 HTTP 契约字段，需单独评估
- [ ] `web/src/api/types.ts` 导出的 `ServiceReorderRequest` 目前零引用
      （`client.ts` 的 `reorderServices` 用内联对象数组类型）。冗余但无害，顺手时可统一
- [ ] **登录限流是硬编码常量，且 E2E 会撞上它**：`LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }`
      写死在 `server/src/api/auth.ts`，不可通过环境变量调整。Sprint 2 新增两条 E2E 用例后
      登录次数达到 11 次/分钟，末尾用例被 429 挡在登录页（症状是"登录页标题一直不消失"，
      容易被误判成页面坏了）。**已改为"每个角色只真正登录一次、其余复用缓存会话，
      并在会话被「退出」撤销时自愈重登"**（不是放宽限流，安全控制一个字没动）。
      若将来用例继续增长，可考虑把这个限流做成可配置项（默认值不变），
      但要先论证它不会削弱暴力破解防护
- [ ] **W2 交付文件里两处注释已过期（低风险）**：`alerts/engine.ts` 的 `readExitCode`
      容错读法，与 `alerts/types.ts` 里"Sprint 2 的 ContainerSummary 没有映射 ExitCode"的注释，
      在 `exitCode` 映射补上之后已经不准确（**行为无需改**，容错读法照样工作），顺手可简化
- [ ] **判据写进规格前要先算一遍（教训）**：Sprint 2 规格 §1.1 我写的"每小时只 2 次批量写"
      与"分钟落库"在算术上不可兼得（真实是 60 次 flush + 1 次 rollup = 61 次/小时）。
      已加勘误块并改为机器可证的三条判据。**验收判据必须能被一条命令证伪**，
      否则它只是措辞

### Sprint 2 验收驳回修复及后续收口的未做项与残留风险（照实记录）

- [x] **上一轮记的"`visibleServiceRefs()` 的 fail-closed 分支没有单测"已更正 —— 现在有覆盖**（本轮）：
      修法抽成共享函数后，`alertsVisibility.test.ts` 把 `handle.ctx.services` 换成**必抛桩**
      走真实路由，断言事件列表与摘要只剩宿主类事件、整段 JSON 无泄漏串，还原后恢复原样；
      共享的 `loadVisibleServiceRefs` 另有"正常返回集合 / 抛错返回 `null`"的纯函数边界用例。
      **照实记**：**metrics 路由级**的 fail-closed 仍没有专门断言（被证明的是同一份实现，
      但"catalog 不含服务类 target、host 仍返回"这条断言本身仍未单独写）
- [x] **告警读接口的可见性泄漏已收口（同类第三处第一组，提交 `871c3dc`）**：`/api/alerts/events` 与
      `/api/alerts/summary` 曾直接返回**触发时**落库的 `target` / `target_label` / `message`，
      隐藏前产生的告警仍带出服务名，且**计数本身就是存在性证据**（"未恢复从 3 掉到 2"）。
      修法：抽出共享 `modules/visibility/serviceVisibility.ts`（`loadVisibleServiceRefs` 刻意不缓存、
      读失败返回 `null`），metrics 与 alerts **调同一组函数**（alerts **不**实例化 `MetricsSampler`）；
      告警在 **SQL 层**过滤：`items` 先过滤再 `LIMIT`（否则"看得见的事件却翻不到"），
      `total` / `counts` / `bySeverity` / `top` 同步只统计可见集合；**admin 无角色特例**；
      可见集合不可得 → **fail-closed**（宿主类 `host`/`disk` 事件恒可见）；
      **引擎语义刻意不动**（行不删、`resolved_at` / `reopen_count` / duration 门控都不变，
      "库里仍未恢复、viewer 看不见"是有意的；恢复可见后同一事件原样回来）。
      判别力实测：完全不过滤 → 新文件 15 例中 **12 红**；仅 `counts` 不过滤 → **9 红**。
      回归 `server/tests/alertsVisibility.test.ts`（当时 15 条；**第二组收口后为 27 条**）；
      `alertsApi.test.ts` 只调夹具、未削弱或删除任何既有断言。实测：3 文件 78 例全绿
      （归档时独立复跑；第二组收口后 server 全量为 **34 文件 / 643 例**全绿）
- [x] **告警读路径第二组已收口（提交 `470ac16`）**：
      ① `GET /api/alerts/rules` 的 `rule.target` —— **已裁定并落地**：**仅对 viewer 遮蔽成 `null`、
      admin 保留真值**（规则是 admin 自己写的**配置**，不是触发快照；对作者本人遮蔽保护不了任何东西，
      只会让 `AlertRuleForm.tsx:163` 把空 target 渲染成"· 适用于全部目标"**对 admin 说假话**）；
      实现上 `rules(visible, { maskServiceTargets })` 的两个入参**必填无默认值**，admin 分支不查注册表。
      ② `summary.suppressed` —— **已收口**：从"引擎全局总数"改为**按 target 明细 + 当前可见性求和**
      （宿主自有恒计入、服务类须命中可见集合、可见集合不可得 → 只计宿主自有，fail-closed）。
      口径边界：**事件 / 快照类**接口（`/events`、`/summary`、`/api/metrics/*`）**不分角色**；
      **配置类**接口（`/rules`）**区分角色** —— 两套口径不要互相套用。
- [ ] **告警读路径仍未收口（待裁定，照实记）**：`POST /api/alerts/events/:id/ack` 的**响应体** ——
      admin 写路径，入参是随机 UUID 的事件 ID，要拿到隐藏服务事件的 ID 得先有别的泄漏渠道。
      收口范围是**读**响应
- [ ] **已知残留：同一件事的两种判据方向相反（本轮不修，代码注释已互相引用标注）**：
      `alerts/service.ts` 里"这个 target 算不算宿主自有"—— SQL 形态 `HOST_OWNED_EVENT_SQL` 是**黑名单**
      （"不是 `service:` / `container:` 前缀就算宿主"），内存判据 `isHostOwnedAlertTarget` 是**白名单**
      （"就是 `host` 或 `disk:` 才算"）。于是空串 / 未知前缀（`weird:secret`）这类**手工脏行**：
      **事件列表里被当宿主放出，`suppressed` 计数与 `/rules` 的 `target` 上却被 fail-closed 剔出 / 遮蔽**。
      两者都保守但方向相反 ⇒ 同一批脏行在这几处可能不一致。要统一得先裁定"未知前缀到底算不算一个目标"
- [ ] **前端文案的复用风险（本轮不需要改 `web/**`）**：`web/src/components/AlertRuleForm.tsx:163`
      把空 target 渲染成"· 适用于全部目标"。因为 `rule.target` **只对 viewer 遮蔽**，admin 拿到的是真值，
      该文案**现在对 admin 不再说谎**，所以本轮不动前端。但**若将来出现"对 admin 也遮蔽"的复用点**
      （例如把 `maskServiceTargets: true` 用在 admin 路径上，或新增一个 admin 也遮蔽的读接口），
      这个文案会**再次说谎** —— 那里必须一并处理，不能只改服务端
- [ ] **`state(ref)` 语义收紧的连带影响需一起看**：`MetricsSampler.verdictOf` 是
      `health.state(ref)?.verdict ?? 'unknown'`，因此"不可见"在采样侧表现为 `unknown` → 该 tick
      不产生样本（方向安全：宁缺测不写 0）；`AlertEngine` 快照用 `health.states()`，
      隐藏服务从快照消失 → 它的未恢复告警**停在未恢复状态**。**本轮收口的是"读"响应**
      （这些事件不再被 viewer 看到/计数），**这条引擎语义本身未动**；改任一处都要一起看
- [ ] **每次读都查一次注册表的代价**：`loadVisibleServiceRefs()` 刻意不缓存（"任何 TTL 都是泄漏窗口"）。
      默认 `PORTAL_CACHE_CONTAINERS_TTL_MS = 2000` 时由服务注册表既有的 TTL 缓存吸收
      （不产生 Docker 调用 + single-flight 合并并发），但该 TTL 允许设为 **0（不缓存）**，
      那时每个 `/api/metrics/catalog`、每个服务类 `/api/metrics/history`，以及告警侧的
      `/api/alerts/events`、`summary` 徽标轮询（每 60s 各一次）与 **viewer 的 `/rules` 读**
      都会真的跑一遍服务发现（`/rules` 自第二组收口起只在 **viewer** 侧取可见集合，
      **admin 侧不查注册表**）。
      若将来要优化，**不能**用"给可见性加 TTL"的办法（那就把泄漏窗口换回来了），
      只能从"读路径是否需要全量服务视图"入手
- [ ] **`docs/sprint2-implementation-spec.md` §3.1 的方法签名清单已过期**：仍写着
      `availableTargets / resolveTarget / catalog` 的同步形态（实现已改 async 并多一层可见性校验），
      也**没有** `AlertsService.events(query, visible)` / `summary(visible)` 的必填可见性参数，
      以及第二组新增的 `rules(visible, options)` 两个必填入参（`AlertRuleReadOptions.maskServiceTargets`
      无默认值）与 `AlertSummaryEngine.suppressedByTarget()` / `composeAlertSummary(…, visible)`。
      冻结规格本轮**未改**（按"实现为准"归档在 `03-server-modules.md` 与 `04-api-contract.md`），
      是否回填规格由下一轮决定
- [x] **`README.md` 的测试规模数字已随 `330b172` 更正**（上一轮记的"未更新"至此关闭）：
      README 现在写 **server 34 文件 / 643 用例**、**815 个用例**（server 643 + web 172），
      与实测逐字一致（归档时复跑：server 34 文件 / 643 例、web 10 文件 / 172 例、exit 0、
      **0 skipped**）。E2E 的 **12 条**也复核为 `smoke.spec.ts` 10 + `security-headers.spec.ts` 2。
      **仍照实记**：既有文档里那个用例数分解（`metricsVisibility` 13 + `clockBoundary` 4 +
      `healthMonitor` 4 + `alertsVisibility` 15 + 第二组 +12）比实测增量 **少 1**（594 → 631 时就已差 1）
      —— 明细以各文件实测为准，**别再把那个分解当成可加总的账**。
      另：`03-server-modules.md` §5 里既有条目的用例数（如 `metricsSampler.test.ts`）未逐个重数
- [x] **归档完成度（第一组那轮）**：告警读接口可见性收口的实现 / 契约 / 安全 / 变更记录已分别落到
      `03-server-modules.md`（新增 `src/modules/visibility/` 章节 + alerts SQL 层过滤小节）、
      `04-api-contract.md`（§6.9 读路径可见性语义）、`06-security.md`
      （不变量扩展到告警读接口 + 残余风险 #11 改写）、`09-changelog.md`，
      并在 `IMPLEMENTATION_REPORT_S2.md` §2.8 新增第 4 条；`todo.md` 同步更正
      "告警未收口"与"fail-closed 无单测"两条**已过时的表述**。
      **第二组（`470ac16`）的归档**：`04-api-contract.md` §6.9 新增"第二组收口"小节（
      **并清掉与代码相反的三处旧决定**：`rule.target`、`suppressed`、"未收口/待裁定"表）、
      `03-server-modules.md` 函数表与路由表、`06-security.md` §3 不变量与 §9-11、本文件、
      `IMPLEMENTATION_REPORT_S2.md` §1/§2.8/§6/§7/§8、`09-changelog.md` 末条
- [x] **上次归档时发现的工作区未提交改动，已落地并归档（提交 `470ac16`）**：
      `AlertTickResult.suppressedByTarget`（按 target 拆开的被压触发次数）已落地，引擎的
      `suppressedTotal()` **已删除**、改为 `suppressedByTarget()`（`Map<target, count>` 只读快照），
      读路径按可见性求和；`AlertsService.recordTick` 的签名改为**只收明细**（不收总数）。
      `03-server-modules.md` / `04-api-contract.md` §6.9 / `06-security.md` §9-11 里
      "`suppressed` / `evaluatedAt` 不参与可见性过滤（残留观察）"的表述已一并更正
      （`evaluatedAt` 保留"无可见性语义"的说法 —— 它不指向任何目标）
- [ ] **`suppressed` 收口带来的运维盲区（有意行为变化，归档时核对代码发现，照实记）**：
      收口后**按 target 的全量明细没有任何对外通道** —— `/api/alerts/summary` 只给按可见性求和后的
      数字，调度器日志只记 `at` / 耗时 / `error`（`toSchedulerView` 不暴露 `alerts`），
      全量明细只在进程内（`scheduler.lastSummary()?.alerts.suppressedByTarget`，目前只有测试读它）。
      于是"**被隐藏 / 已删除的服务是不是一直在被压掉**"在界面上看不出来，要判断得先恢复可见性。
      这是安全优先的必然代价，但若将来要给 admin 一个全量视图，**应新开管理侧（`includeHidden` 口径）
      的读接口**，不要给 `/summary` 加角色分支（那会与"事件 / 快照类不分角色"打架）。
      已写入 `08-operations.md` 告警运维小节与 `09-changelog.md` 本轮的"已知限制"
- [ ] **`suppressed` 侧没有独立的突变（判别力）实验（本轮的实验只覆盖角色分支）**：
      本轮的突变实验只有**角色分支**（恒遮蔽 / 恒放行 → `/rules` 3 例红）。
      `suppressed` 侧的判别力由**非零夹具**承担（用例自检 `suppressed === 2` 且归因为
      `host 1 + 目标服务 1`）—— 这**不等于**一次变异实验，若下一轮要更强的证据，
      应补"临时取消 `sumSuppressedVisible` 的可见性判定 → 对应用例必须红"

### `suppressed` 组测试隔离修复（提交 `330b172`；归档见 `09-changelog.md`）

- [x] **`alertsVisibility.test.ts` 的 suppressed 组不再依赖宿主 Docker / 探测**（本轮）：
      复审唯一阻断项是该文件 `beforeAll` 在默认配置下稳定超时 —— 它连续跑两次真实
      `scheduler.tickOnce`，却只换了宿主快照，Docker 列表与健康探测仍走真实外部世界，
      6 条最关键的 suppressed 用例被跳过、`npm test` 失败（用户实测 server 637 通过 / 6 跳过；
      加 `--hookTimeout=120000` 后 6/6 通过但耗时约 **102 秒**）。按用户要求**不提高任何超时**，
      改为在组内换掉四个外部世界（宿主快照 / `containers.list` / 探测注入 + `probeIntervalSec` 钉 1；
      `ctx.services` **刻意不换**，见 changelog）；**未改任何断言、无 skip、未动超时**；
      另新增一条 **5 秒耗时上界**断言，把"不许重新混入真 Docker"变成可执行约束。
      归档时复跑：单文件 **27 例**、`Duration 2.87s`（tests 1.73s）；默认 `npm test` server
      34 文件 / 643 例、web 10 文件 / 172 例，exit 0、**0 skipped**
- [ ] **本机无法复现用户那台机器的 102 秒，"修复有效"由机制证据支撑，仍需在有 Docker 的机器上复核一次**（照实记）：
      本机 Docker 守护进程**是活的**（实测 `docker version` → Server `29.8.0`），`containers.list()`
      每次调用约 0–1ms，因此**即使把修复前的那个文件原样拿出来单独跑，本机也是 27 例全绿
      （`Duration 3.46s`）** —— 慢路径在本机根本走不到，"102 秒"无法验证。
      支撑"修复有效"的是两条机制证据：① 用临时探针统计，`containers.list` **每轮 tick 被调用 6 次、
      两轮共 12 次**（与提交信息"假 containers 每 tick 被调用 12 次"的措辞不同，**实测是每轮 6 次**；
      另一次独立探针在"两轮共 13 次（7 + 6）"，差额来自夹具服务与规则配置不同）—— 这 12 处调用点
      现在全部落在注入的假夹具上，说明夹具确实接住了容器类取数；② 5 秒耗时上界断言
      （真去连 Docker 单次超时就是 10⁴ms 级）。
      取证时的**自我干扰**也照实记：那次探针是在修复前的旧文件上给 `containers.list` 加计数包装，
      结果同一文件出现 3 红 + 5 跳过（`PATCH /api/services/:id` 返回 500），而**未加包装的原文件
      同机全绿** —— 计数探针本身会干扰该文件，**"12 次"这条数字只在探针运行下成立、未在交付代码里复核**
- [x] **本轮**（`330b172`）的归档已完成：`09-changelog.md` 新增条目、`03-server-modules.md` §5
      的 `alertsVisibility.test.ts` 行补夹具/驱动方式、`08-operations.md` **§12.0** 新增"单测与外部环境无关"
      一节、本文件三点同步；`README.md` 的数字由代码提交更新，**本轮未动**

## 环境备忘

本机（开发环境）实测结果：

| 项目 | 值 |
| --- | --- |
| Docker | 29.8.0，Docker Desktop，容器内 endpoint = `unix:///var/run/docker.sock` |
| 现有容器 | 6 个（cs22-backend / cs22-web / cs22-ml-service / sisi-calendar / worldforge / homeport-portal 自身） |
| Tailscale | 1.102.4，本机 `Sisi-Laptop` / `100.72.255.29`，11 台设备 |
| GPU | RTX 4060 Laptop 8G。**容器化下不可读**（容器内无 `/usr/lib/wsl/lib`）；原生运行可读 |
| Node | v22.23.2 |
| 平台 | Windows 11，宿主 20 线程 / 31.63 GB；容器内只可见 WSL2 的 4 线程 / 3.9 GB |

目标部署机（NAS）实测结果：

| 项目 | 值 |
| --- | --- |
| 设备 | 绿联 DX4600 Pro，Tailscale 名 `family-nas` / `100.103.230.37` |
| **CPU 架构** | **x86-64（amd64）** —— 不是 arm64。选镜像时务必确认，单架构镜像选错会 `exec format error` |
| 系统 | Linux 6.18.15，Tailscale 1.104.1 |
| 网络 | tailnet 直连（ping 约 294ms）；22 与 443 开放，**2375/2376 未开放**（Docker API 未对外暴露） |
| 部署状态 | **暂不部署**（用户 2026-10-16 决定"先把镜像备好"）。多架构镜像已就绪，`docker-compose.nas.yml` 与部署流程（08-operations §3.2）已备好 |

部署状态（2026-10-16，改名迁移后已实测）：

- 新容器 `homeport-portal`（镜像 `homeport:local`）`Up (healthy)`，映射 `0.0.0.0:8899->8899`
- 旧容器 `homepage-portal` 已由 `--remove-orphans` 清除
- 数据卷已迁移到 `homeport-data`，实测两个 admin 账号 / 11 个会话 / 2 条偏好全部保留，
  `setupRequired: false`（未触发重新初始化）
- 旧卷 `homepage-data` **保留未删**，如需回退可直接挂回去
- **注意**：日后若从更早的备份重建，旧容器不移除会继续占用 8899 端口，`up` 需带 `--remove-orphans`
- 登录账号：`admin` / `********`（**建议登录后立即修改**；密码值已在推公开仓库前打码，
  真实值请自行保管 —— 需要查看可用 `docs/static/08-operations.md` 的重置密码流程）
- 访问地址：`http://100.72.255.29:8899`（tailnet）或 `http://localhost:8899`
