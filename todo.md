# TODO

> 最后更新：2026-10-16

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
- [ ] **历史趋势图**：目前只有瞬时值。可加环形缓冲区记录最近 N 分钟 CPU/内存，
      前端画折线（注意 NAS 内存占用，建议只保留内存内数据不落盘）
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
