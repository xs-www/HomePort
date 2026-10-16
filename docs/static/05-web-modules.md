# 05 · 前端模块（静态函数文档）

> 技术栈：React 19 + Vite 6 + TypeScript + Tailwind CSS 4 + React Router 7。
> 无全局状态库（Context 足够），无 UI 组件库（自建原子组件，见 `components/ui.tsx`）。

## 1. 目录结构

```
web/src/
├── main.tsx                  # 入口：createRoot + StrictMode
├── App.tsx                   # BrowserRouter + AuthProvider + 路由表 + 守卫
├── index.css                 # Tailwind 入口 + 主题 token + 组件类
├── api/
│   ├── types.ts              # 与后端契约逐字段对应的类型（S0/S1）
│   ├── client.ts             # ApiClient / ApiError / api 单例
│   ├── metrics.ts            # 历史指标契约镜像 + 单位格式化（S2-02）
│   └── alerts.ts             # 告警契约镜像 + 展示文案（S2-04）
├── auth/AuthProvider.tsx     # 会话、偏好、主题、CSRF 注入
├── hooks/
│   ├── useAsync.ts           # useAsync / useSubmit / useLocalState
│   ├── useMetricsStream.ts   # SSE 订阅
│   ├── useMetricsHistory.ts  # 历史曲线 + 可用目标（S2-02）
│   └── useAlertSummary.ts    # 告警未确认计数（导航徽标，S2-04）
├── lib/format.ts             # 展示格式化（与后端 util/format 职责互补）
├── components/ui.tsx         # Badge / Card / ProgressBar / StatCard / ...
├── components/               # 服务相关（S1）：ServiceCard / ServiceIcon / UrlCandidateList
│                             #   / ServiceForm / Modal / CommandPalette
│                             # 历史与告警（S2）：MetricsChart / MetricPicker
│                             #   / AlertEventList / AlertRuleForm
├── layout/
│   ├── AppShell.tsx          # 侧边导航 + 顶栏 + 内容区
│   └── Shell.tsx             # AppShell 的薄包装（供页面直接使用）
└── pages/                    # 12 个页面 + 404
```

**分层约定**

1. 页面用 `useAsync(loader)` 取数，`loader` **必须** `useCallback` 包裹。
2. 页面不直接 `fetch`，一律走 `useApi()`（`ApiClient` 实例）。
3. 展示格式化只在 `lib/format.ts`，不在 JSX 里手写。
4. 通用 UI 原子只在 `components/ui.tsx`，页面内不复刻徽标/进度条样式。

## 2. `api/types.ts`

与后端契约逐字段对应。**来源**：`docs/static/04-api-contract.md`。
后端改接口必须同步本文件与文档，否则会出现静默的类型漂移。

主要类型：`SessionView` `SessionUser` `UserPreferences` `HealthResponse`
`ContainerSummary` `ContainerDetail` `ContainerPortView` `ContainerLogsResponse`
`TailnetDevice` `TailnetStatusResponse` `SystemSnapshotResponse` `SystemMetricsFrame`
`ToolView` `ToolListResponse` `OverviewResponse` `AuditEntry`

服务注册表（S1）**逐字段镜像** `server/src/modules/services/types.ts`：
`ServiceView` `ServiceEntryView` `ServiceStatusView` `ServiceContainerRef` `ServiceDiscoveryState`
`ServiceListResponse` `ServiceDiagnostics` `ServiceDetailResponse`、`ServiceSearchHit`（含
`ServiceSearchKind`）/ `ServiceSearchResponse`、`ServiceHealthView` / `ServiceHealthResponse`、
`ServiceDeleteResponse`，以及请求类型 `ServiceCreateRequest` / `ServiceUpdateRequest`。
`ApiClient` 对应新增 `services()` / `service()` / `createService()` / `updateService()` /
`deleteService()` / `reorderServices()` / `discoverServices()` / `probeServiceHealth()` / `search()`。

两步验证（TOTP）相关：`LoginSuccessResponse` / `LoginTotpChallengeResponse` 与其判别联合
`LoginResponse`（用导出的类型守卫 `isTotpChallenge()` 分支）、`LoginTotpRequest`、
`TotpSetupResponse`、`TotpEnableRequest` / `TotpEnableResponse`、
`TotpDisableRequest` / `TotpDisableResponse`、`TotpRecoveryCodesRequest` /
`RecoveryCodesResponse`、`TotpResetResponse`。`SessionUser` 新增
`totpEnabled: boolean` 与可选 `totpConfirmedAt?: string | null`（后端已返回，用于显示"启用时间"；
契约只承诺前者，所以声明为可选、缺失时界面显示 `—`）。

**Sprint 2 起契约镜像按功能拆文件**：`api/metrics.ts`（历史指标）、`api/alerts.ts`（告警）
各自镜像 `server/src/modules/metrics/types.ts` / `modules/alerts/types.ts`，
**不再往 `types.ts` 里堆**。理由有两条：一是这两组类型只被一两个页面用到，
塞进 `types.ts` 会让"所有页面共享的契约"与"某个功能的契约"混在一起；
二是它们各自还带**展示格式化函数**（`formatMetricValue` / `describeAlertKind` 等），
类型与"这类值该怎么显示"留在同一处才不会两处各维护一半。详见 §11、§12。
前端仍**不 import 后端代码**，字段名逐字对应（与 S1 同一纪律）。

## 3. `api/client.ts`

### `ApiError`

```ts
class ApiError extends Error {
  readonly code: string;       // 后端 error.code
  readonly status: number;     // HTTP 状态码
  readonly details: unknown;   // 后端 error.details
  get fieldErrors(): Record<string, string[]>;  // details.fieldErrors
}
```

### `ApiClient`

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `constructor` | `(ApiClientOptions)` | `{ baseUrl?, timeoutMs?, getCsrfToken?, onUnauthorized? }` |
| `request`（私有） | `<T>(path, RequestOptions) => Promise<T>` | 统一 fetch。`credentials: 'same-origin'`；变更类请求自动加 `X-CSRF-Token`；超时用 `AbortController`（默认 20s，慢接口 45s）；`204` 返回 `undefined` |
| `health` | `() => Promise<HealthResponse>` | 跳过 401 回调 |
| `session` | `() => Promise<SessionView>` | 跳过 401 回调 |
| `login` | `({username,password,remember}) => Promise<LoginResponse>` | 跳过 401 回调（否则登录失败会触发"会话失效"逻辑）。返回**判别联合**：可能是"需要第二步" |
| `loginTotp` | `({challengeToken,code,remember}) => Promise<LoginTotpResponse>` | 登录第二步；在**建立会话之前**调用，故跳过 401 回调、不假设已有 CSRF |
| `logout` / `bootstrap` / `changePassword` / `sessionActivity` | — | 认证 |
| `overview` | `() => Promise<OverviewResponse>` | 慢接口超时 |
| `containers` / `container` / `containerLogs` | — | 容器 |
| `tailnetDevices` / `tailnetStatus` | — | tailnet |
| `systemSnapshot` | — | 系统 |
| `tools` / `probeTool` | — | 工具 |
| `me` / `updatePreferences` / `users` / `createUser` / `updateUser` / `deleteUser` / `resetUserPassword` / `revokeUserSessions` / `auditLog` | — | 用户 |
| `totpSetup` / `totpEnable` / `totpDisable` / `totpRegenerateRecoveryCodes` | — | 两步验证自助管理（需登录 + CSRF） |
| `resetUserTotp` | `(id) => Promise<TotpResetResponse>` | admin 强制重置：清绑定 + 吊销全部会话，返回 `revokedSessions` |
| `metricsHistory` | `({metric,target,range}) => Promise<MetricHistoryView>` | 历史曲线（viewer）。纯 `SELECT`，走**默认**超时、不共用慢接口的 45s；query 经 `URLSearchParams` 编码，故 `target=disk:C:` 实际发成 `disk%3AC%3A`（单测按编码后的 URL 断言） |
| `alertRules` | `() => Promise<AlertRuleListResponse>` | 规则列表（viewer）。响应形状是 `{ items }`（§7 补冻结），直接用冻结类型取字段，**不做宽容解析** |
| `updateAlertRule` | `(id, patch: AlertRulePatch) => Promise<AlertRuleView>` | **admin**，`PATCH /api/alerts/rules/:id`；id 走 `encodeURIComponent`；变更类请求自动带 CSRF |
| `alertEvents` | `({state?, limit?} = {}) => Promise<AlertEventsResponse>` | 事件列表（viewer）。`state` 默认 `all`；`limit` 由服务端夹到 `1..200`（前端传 100） |
| `acknowledgeAlertEvent` | `(id) => Promise<AlertEventView>` | **admin**，`POST /api/alerts/events/:id/ack`（CSRF）。已恢复的事件也能确认 |
| `alertSummary` | `() => Promise<AlertSummaryView>` | 徽标计数（viewer）。§7 冻结为**聚合对象本身**（不是列表），同样不归一化 |

**Sprint 2 对 `client.ts` 是纯新增（+68/−0）**：只加 import 与上面 6 个方法，
**没有改动任何既有方法**（包括 `request()` 的 CSRF / 401 / 超时逻辑）。
这一点有实际意义 —— Sprint 0/1 的 `client.test.ts` 与所有既有页面的行为不受本次改动影响。

`toApiError(payload, status)` 把后端错误体转成 `ApiError`；无法识别时按状态码给中文兜底文案。

**401 的语义细分（S0-03 修正）**：`request()` 在 `401` 时只有当错误码**不属于**
`CREDENTIAL_FAILURE_CODES = { TOTP_INVALID, TOTP_CHALLENGE_EXPIRED, INVALID_CREDENTIALS }`
才触发 `onUnauthorized`。原因是这三个码表示"这次提交的凭据/验证码不对"，
改造前会把"输错一次 TOTP 验证码（或当前密码）"直接变成强制登出；
真正的会话失效仍是 `UNAUTHORIZED`，照旧跳登录页。

## 4. `auth/AuthProvider.tsx`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `AuthContextValue` | interface | 见下 |
| `AuthProvider` | `({children}) => ReactNode` | 创建并持有一个 `ApiClient`，把 CSRF 取值与 401 处理注入其中 |
| `useAuth` | `() => AuthContextValue` | 必须在 Provider 内 |
| `useApi` | `() => ApiClient` | 取同一实例（保证 CSRF 一致） |
| `applyTheme` | `(theme: 'dark'\|'light'\|'system') => void` | 切换 `<html class="dark">` 与 `color-scheme` |

`AuthContextValue`：`api` `ready` `user` `preferences` `setupRequired` `apiVersion`
`login` `completeTotpLogin` `bootstrap` `logout` `refresh` `updatePreferences` `isAdmin`

**两步验证登录（S0-03）**

- `login()` 返回判别联合 `LoginOutcome = { status: 'ok' } | { status: 'totp'; challengeToken; expiresAt }`：
  后端第一步返回 `totpRequired` 时**没有**会话 Cookie，`AuthProvider` 只把
  `challengeToken` 交给登录页，自身不保存。
- `completeTotpLogin({ challengeToken, code, remember })` 调 `/api/auth/login/totp`，
  成功后与普通登录走同一条收尾逻辑（`establishSession()`：写 CSRF、用户、偏好）。
- **`challengeToken` 只存在组件状态里**，不写 localStorage/sessionStorage：刷新即失效，
  与后端 5 分钟 TTL 配合，避免半途凭据留在浏览器里。
- `bootstrap()` 在首启流程里仍直接调 `login()`；若意外收到 `totp` 分支则抛错，
  不假装登录成功。

**关键设计**

- **CSRF 单一来源**：令牌存在 `csrfRef`，`ApiClient` 通过闭包读取。
  避免"多处各建一个 client 导致 CSRF 不同步"。
- **主题防闪白**：`localStorage` 里的主题在拉会话**之前**先应用，
  再由服务端偏好覆盖。
- **健康轮询**：每 60s 拉一次 `/api/health` 取版本号（失败静默）。
- **`bootstrap` 后自动登录**：省去用户再输一次密码。

## 5. `hooks/useAsync.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `AsyncState<T>` | interface | `{ data, loading, error, loaded, reload }` |
| `useAsync<T>` | `(loader, UseAsyncOptions?) => AsyncState<T>` | `{ refreshIntervalMs?, immediate?, keepPreviousData? }`。内含**并发保护**（序号比对，只接受最后一次结果）、卸载保护、页面不可见时跳过自动刷新 |
| `SubmitState` / `useSubmit` | `() => SubmitState` | 表单提交：`submitting` / `error` / `fieldErrors` / `submit(action)` 返回是否成功 |
| `useLocalState<T>` | `(key, initial) => [T, (v:T)=>void]` | 持久化到 `localStorage`（筛选条件记忆） |

## 6. `hooks/useMetricsStream.ts`

| 导出 | 说明 |
| --- | --- |
| `StreamStatus` | `'connecting' \| 'open' \| 'error' \| 'closed'` |
| `MetricsStream` | `{ frame, status, frames, lastError, reconnect }` |
| `useMetricsStream` | `(enabled = true) => MetricsStream` |

订阅 `/api/system/stream`。断线重连交给浏览器 `EventSource` 内建行为；
`error` 事件在重连期间会反复触发，因此只更新状态、不视为致命错误。

## 7. `components/ui.tsx`

| 导出 | 关键 props | 说明 |
| --- | --- | --- |
| `Badge` | `tone?` `dot?` `pulse?` `title?` `children?` | 状态徽标；`children` 可省略（只渲染圆点） |
| `Card` | `title?` `subtitle?` `actions?` `bodyClassName?` | 卡片容器 |
| `ProgressBar` | `percent` `label?` `hint?` `height?` `thresholds?` | 阈值配色：`<70%` 绿蓝、`70-88%` 琥珀、`>88%` 玫瑰 |
| `StatCard` | `label` `value` `sub?` `tone?` `percent?` `icon?` `footer?` | 概览大号指标卡 |
| `KeyValue` | `label` `children` | 键值行 |
| `SourceNotice` | `status` `compact?` | 数据源不可用/降级提示条。**正常数据源返回 null** |
| `EmptyState` / `Skeleton` / `Spinner` / `ErrorNotice` | — | 空态/骨架/加载/错误 |
| `Icon` | `name` `className?` | 内联 SVG 图标集（避免引入图标依赖） |

`Tone` = `'ok' | 'warn' | 'bad' | 'idle' | 'brand'`。

## 8. `layout/`

**`AppShell.tsx`** — `AppShell({ children, topbarExtra?, title? })`

- `>= lg`：固定侧栏（`lg:sticky lg:h-screen`）。
- `< lg`：抽屉式侧栏 + 遮罩，路由切换后自动收起。
- 侧栏底部：用户卡片、主题切换（暗/亮/跟随系统三态循环）、退出登录、服务端版本。
- 导航项由 `NAV_ITEMS` 定义，"服务管理""账号管理"带 `adminOnly`，对 viewer 隐藏。
- **Sprint 2 追加 `历史`（`/history`）与 `告警`（`/alerts`）**：两者都是**只读页面**
  （写入口在页面内部按角色渲染），因此**不带 `adminOnly`、对 viewer 也可见**。
  图标复用 `Icon` 集中已有的 `system` 与 `warning`，**没有新增图标依赖**。

**告警未确认计数徽标（S2-04，E2E/单测断言点）**

- 数据源是 `useAlertSummary({ enabled: user !== null })` —— **未登录不发请求**：
  `AppShell` 在 404 页也会渲染，那时没有会话，发请求只会拿 401 并触发全局"会话失效"逻辑。
- **徽标是 `NavLink` 的兄弟节点**（`<div className="relative">` 包裹），
  且带 `pointer-events-none` 保证点击穿透。放**进**链接里会把链接的可访问名
  污染成"告警 3"，而既有测试与 E2E 都按 `getByRole('link', { name: '告警' })` 找它 ——
  可访问名必须保持干净。
- 数字取 `summary.unacknowledged`（**未恢复且未确认**），不是 `open`；
  `unacknowledged === 0` 时**不渲染**徽标（一个恒亮的 "0" 只会变成噪音）。
- `title` 里额外报 `suppressed`（命中静默期被压掉的触发次数）：
  "没有告警"到底是被压了还是条件没成立，靠它区分。
- 测试：`web/tests/alertsPage.test.tsx`（"徽标数字来自 `unacknowledged`（不是 `open`）"、
  "未确认计数为 0 时不渲染徽标（即使还有未恢复事件）"）。

**`Shell.tsx`** — `Shell(props)`，`AppShell` 的薄包装。
页面内部使用它而不是在 `App.tsx` 里包，原因：守卫需要直接 `return <Navigate>`
（此时导航栏会消失），把外壳放在页面内可保证任何守卫分支都不丢导航。

## 9. `pages/`

| 页面 | 路由 | 数据来源 | 要点 |
| --- | --- | --- | --- |
| `ServicesPage`（**首页**，S1-04） | `/` | `/api/services` | 服务墙：搜索入口、数据源降级提示、收藏区 + 分类分组（可折叠）、卡片网格（`sm:2` / `xl:3` 列）；viewer **不渲染任何管理入口** |
| `ServiceDetailPage`（S1-04） | `/services/:id` | `/api/services/:id` | 为什么这个服务是现在这个样子：`status.reasons` 逐条 + **全部**候选入口（含不可达）+ 诊断（容器端口 / serve 路由 / notes）；hidden 对非管理员 404（如实报错，不白屏） |
| `LoginPage` | `/login` | `useAuth().login` / `completeTotpLogin` | **两步登录**（见下）；不做"忘记密码"（本地账号体系无邮件通道），明确提示联系管理员 |
| `SetupPage` | `/setup` | `useAuth().bootstrap` | 需首启令牌；密码二次确认；已初始化时显示引导而非报错 |
| `OverviewPage` | `/overview` | `/api/overview` + SSE | 四张指标卡、硬件进度条、在线设备、featured 工具、数据源告警。**Sprint 1 起从 `/` 迁到 `/overview`** |
| `ContainersPage` | `/containers` | `/api/containers` | 容器墙；搜索 + 可达性过滤 + 含已停止 + 实时占用开关（筛选条件持久化） |
| `ContainerDetailPage` | `/containers/:id` | `/api/containers/:id` + `/logs` | 基础信息、实时占用、端口表（含可达性）、备选入口、挂载、脱敏环境变量、日志（可选行数） |
| `DevicesPage` | `/devices` | `/api/tailscale/devices` | 设备表；搜索、只看在线、多种排序、点击复制 IP |
| `SystemPage` | `/system` | `/api/system/snapshot` + SSE | CPU（含各核心热力条）、内存、GPU（含占用进程）、磁盘；每个数据源标注取数模式 |
| `ToolsPage` | `/tools` | `/api/tools` | 工具卡；状态过滤、分类过滤、单工具强制探测、多候选入口折叠 |
| `HistoryPage`（S2-02） | `/history` | `/api/metrics/history` + `/api/system/snapshot` / `/api/services` | 历史趋势：指标 × 目标 × 时间范围选择器 + 手写 SVG 曲线；**空历史给可读空态而不是 0 平线**；单位/数据源/采样方式/缺测数量四项标注 |
| `AlertsPage`（S2-04） | `/alerts` | `/api/alerts/rules` + `/events` + summary | 告警：计数条、事件表（全部/未恢复/已恢复过滤）、规则**只读**表；写入口（规则编辑弹窗、确认按钮）只对 admin 渲染 |
| `AdminPage` | `/admin` | `/api/users*` | **四个标签页**：用户与权限、审计日志、安全与偏好、系统设置 |
| `AdminServicesPage`（S1-03） | `/admin/services` | `/api/services*` | 服务管理：排序（上移/下移）、收藏、可见性、编辑、新建、删除（手工）/隐藏（自动）/重置为自动、重新发现、一次性健康探测。**删除语义按来源区分**，错误原样呈现（`message` / `fieldErrors`） |
| `NotFoundPage` | `*` | — | 404 |

### 服务墙相关组件（S1-02…S1-05）

| 组件 | 导出 | 要点 |
| --- | --- | --- |
| `components/ServiceCard.tsx` | `ServiceCard` `ServiceStatusBadges` `describeSourceType` | **三个状态维度永远分开渲染**（容器 / 可达 / 健康），各带 `title` 悬停解释与 `data-status`（E2E 可断言）；名称链接进详情页，首选入口是新窗口外链；`entryCount > 1` 时给「查看所有候选入口」 |
| `components/UrlCandidateList.tsx` | `UrlCandidateList` `unreachableLabel` | 候选入口列表（卡片抽屉 + 详情页共用）。**不可达项也要列**并明确标注"仅本机/不可达" |
| `components/ServiceIcon.tsx` | `ServiceIcon` `SERVICE_ICON_NAMES` `SERVICE_FALLBACK_ICON` `isServiceIconName` `isServiceIconUrl` | 白名单键 → 内联 SVG；`https://` → `<img loading="lazy" referrerPolicy="no-referrer">`；其它一律回退 `container`。**不引图标字体/CDN**（默认 CSP `img-src 'self' data:` 会拦掉） |
| `components/ServiceForm.tsx` | `ServiceForm` | 新建/编辑表单（名称/描述/图标选择器/分类/首选入口/健康路径）；E2E 依赖的稳定 id：`#service-name` `#service-description` `#service-icon` `#service-category` `#service-url` `#service-health-path` |
| `components/Modal.tsx` | `Modal` | 通用模态框：`role="dialog"` + `aria-modal` + `aria-labelledby`、打开时移入焦点（支持 `initialFocusRef`）、关闭后**归还焦点**、Esc/遮罩关闭、Tab 不逃逸。StrictMode 双跑 effect 下幂等 |
| `components/CommandPalette.tsx` | `CommandPalette` `CommandPaletteProvider` `useCommandPalette` | `Ctrl/Cmd+K`（`e.ctrlKey \|\| e.metaKey`）全局唤起；数据来自 `/api/search`（服务端按角色过滤）；150ms 防抖 + 递增序号**竞态保护**；`role="combobox"` + `aria-activedescendant`，结果 `role="listbox"` / `role="option"` + `aria-selected`，焦点始终留在输入框 |
| `pages/ServicesPage.tsx`（导出纯函数） | `buildServiceGroups` `discoveryMessages` | 分组（收藏置顶，**收藏项不从分类里重复出现**，避免同一张卡命中两次）；降级文案（后端 `notes` 原样透出，缺失时兜底句子里也明确写出 `Docker` / `Serve`） |

**命令面板的 Enter 行为（固定，E2E 断言）**：`service` → `/services/:id`；`container` → `/containers/:id`；
`device` → `/devices`（设备没有可点击入口，`url` 恒 `null`）；`tool` → 外部新窗口打开 `url`。

### 两步验证界面（S0-03）

**`LoginPage`** — 由第一步的响应决定形态，两种形态是同一个组件的两个分支：

| 分支 | 触发 | 要点 |
| --- | --- | --- |
| 第一步 · 账号密码 | 默认 | 提交后 `login()` 返回 `ok` 直接进门户；返回 `totp` 则切第二步 |
| 第二步 · 两步验证 | 后端 `totpRequired` | 标题"两步验证"；`inputMode="numeric"`、`autoComplete="one-time-code"`、`maxLength=9`（兼容 `XXXX-XXXX` 恢复码）；"返回上一步"；提示本次验证的失效时间 |

第二步的错误处理（两条路径必须分开）：

- `TOTP_INVALID` → 就地 `role="alert"` 报"验证码不正确，请重试"，**保留已输入的验证码**；
- `TOTP_CHALLENGE_EXPIRED` → 清空挑战与密码、保留用户名，退回第一步并提示"验证已过期，请重新登录"。

无障碍：`<label htmlFor>` 关联、`aria-invalid`、`aria-describedby` 指向错误文案（`totp-code-error`）、
提交中 `disabled`、验证码不足 6 位时禁用提交、错误用 `role="alert"`、过期提示用 `role="status"`。

**`SecurityTab` 的「两步验证（TOTP）」区块** — 自助管理，刻意不引入二维码库：

- **未启用**：`启用两步验证` → `totpSetup()` → 展示 `secret`（可选中复制 + 复制按钮）与
  `otpauthUri` 文本，说明"在验证器 App 里手动输入密钥或粘贴 otpauth 链接"；再输入 6 位码
  → `totpEnable()` → **一次性恢复码弹窗**（等宽、逐条、明确"这些码只显示这一次，请立即保存"、
  可复制全部、必须勾选"我已保存恢复码"才能关闭）。
- **已启用**：显示状态与"启用时间"（`totpConfirmedAt`，缺失显示 `—`）；`重新生成恢复码`
  （需当前动态码，旧码立即作废）；`关闭两步验证`（需密码 **+ 当前验证码或恢复码**，
  后端缺验证码时以 `fieldErrors.code` 返回，界面就地显示）。
- `setup` 重复调用会重新生成**未确认**的种子：界面明确提示"会使上一次未确认的种子立即失效"，
  且"重新生成密钥"要二次确认。
- 绑定/关闭成功后调用 `refresh()` 同步 `user.totpEnabled`。

**`UsersTab`** — 对 `totpEnabled` 的用户显示 `两步验证已启用` 徽标，并提供
`重置两步验证`：`window.confirm` 写明"清除绑定 + 吊销全部会话 → 用户会掉线、需重新登录并重新绑定"，
成功后提示带 `revokedSessions` 的文案并刷新列表（`act()` 的第三个参数支持传入函数以使用响应数据）。

### 系统设置面板 `pages/admin/SettingsPanel.tsx`

管理员在界面内修改运行时配置（`/api/settings`）。四条设计约定：

1. **诚实标注生效级别**：`立即生效` / `需重建容器`。后者**不给编辑控件**，
   只展示当前值并说明原因 —— 否则管理员会改了一个改不动的值还以为生效了。
2. **先测再存**：Tailscale Token 旁有「测试连接」按钮，可验证**尚未保存**的候选值，
   避免把错值写进数据库后只看到"数据源不可用"。
3. **局部编辑**：只有被改动过的项进入请求体（`draft` 状态），
   这样"清空某字段"与"从未修改该字段"语义分明；未动的项保持 `.env` 行为。
4. **来源可见**：每项显示 `内置默认` / `环境变量` / `界面设置` 徽标与最后修改人。

顶部还有一张「哪些能改、哪些不能」的说明卡，把容器架构的硬边界写清楚
（延迟生效项、需重建项、磁盘挂载点的"半自动"性质）。

**容器的可点击入口渲染规则**：只有 `port.url !== null`（即判定为 `tailnet`/`lan`）才渲染成链接；
`localhost-only` / 未发布的端口在卡片上以灰底文字说明原因，避免"点了打不开"的困惑。

## 10. `App.tsx` 守卫

| 组件 | 行为 |
| --- | --- |
| `BootScreen` | 会话探测期间的全屏加载态（避免闪屏） |
| `Protected` | `!ready` → `BootScreen`；`setupRequired` → `/setup`；未登录 → `/login`（记录来源路径） |
| `AdminOnly` | 非 admin → `ForbiddenPage`（后端也会独立拒绝） |
| `GuestOnly` | 已登录访问 `/login` → 跳回来源页；`setupRequired` → `/setup` |

**Sprint 2 的两条新路由都只用 `Protected`**（`/history`、`/alerts`）：
它们是 viewer 可读的只读页面，**不加 `AdminOnly`**；
权限收窄在页面内部完成（写入口不渲染），后端再独立拒绝一次 ——
"前端隐藏 ≠ 后端允许"这条纪律在 Sprint 1 之后没有放宽。

## 11. 历史趋势（Sprint 2 · S2-02）

**契约来源**：`docs/sprint2-implementation-spec.md` §1（指标目录）、§3.2（range → resolution）、
§7（响应形状）、§8（前端要求）。前端**不 import 后端代码**，类型手写镜像。

### 11.1 `api/metrics.ts`（契约镜像 + 单位规则）

| 导出 | 签名 / 形态 | 说明 |
| --- | --- | --- |
| `MetricUnit` | `'percent' \| 'bytes' \| 'ratio'` | §1 的三种单位。`ratio` 值域 **0..1**（健康采样占比），显示成百分比但标签写"健康占比" |
| `MetricRange` | `'1h' \| '24h' \| '7d' \| '30d'` | §3.2 的四个窗口 |
| `MetricResolution` | `'minute' \| 'hour'` | 由**后端按 range 选择**并回传，前端不自己推断 |
| `MetricTargetKind` | `'host' \| 'disk' \| 'container' \| 'service'` | 只用来决定"可选目标从哪来"（见 §11.2） |
| `METRIC_CATALOG` | `readonly MetricCatalogEntry[]`（8 项） | §1 目录的**字面副本**，见下 |
| `METRIC_RANGES` | `readonly { value; label }[]` | 最近 1 小时 / 24 小时 / 7 天 / 30 天 |
| `metricByKey` | `(key: string \| null \| undefined) => MetricCatalogEntry \| null` | 未知 key → `null`，调用方据此走空态而不是硬渲染 |
| `resolutionSec` | `(resolution: MetricResolution) => number` | `hour → 3600`、否则 `60`。缺口判定与 X 轴对齐共用同一个值 |
| `rangeLabel` | `(range: string) => string` | 未知值**原样返回**（排障时能看到是哪个值不对） |
| `metricUnitLabel` | `(unit: MetricUnit) => string` | 图表"单位"标注的完整说明（带取值范围） |
| `metricUnitShortLabel` | `(unit: MetricUnit) => string` | 极短标签：`%` / `B/KB/MB/GB` / `健康占比` |
| `formatMetricValue` | `(value: number \| null \| undefined, unit: MetricUnit) => string` | 数值 → 显示串的**唯一入口**（Y 轴刻度、tooltip、最新值都用它） |
| `MetricHistoryView` | interface | §7 响应逐字段镜像；含 `MetricHistoryPoint` / `...Sampling` / `...Source` / `...Gaps` / `...Summary` |
| `MetricTargetOption` | `{ value: string; label: string; hint?: string }` | `value` 直接作为 `?target=` 的值 |

**`METRIC_CATALOG` 为什么是硬编码而不是拉 `/api/metrics/catalog`**：
该端点的响应形状**没有在规格 §7 里冻结**（只有一句"§1 目录 + 可用 target"）。
按猜测解析一个未冻结的形状，等于把契约漂移藏进代码里；而"有哪些指标、什么单位"
本身就是规格写死的事实。目标列表另找**已冻结**的来源（§11.2），
等 catalog 形状进规格后只需替换 `useMetricTargets` 一处。

**range → resolution → 桶宽**（X 轴刻度文案随 resolution 变，因为窗口跨度不同）：

| range | resolution | 桶秒宽 | X 轴刻度文案 |
| --- | --- | --- | --- |
| `1h` | `minute` | 60 | `HH:MM` |
| `24h` | `minute` | 60 | `HH:MM` |
| `7d` | `hour` | 3600 | `MM-DD HH:MM`（窗口跨天，必须带日期） |
| `30d` | `hour` | 3600 | `MM-DD HH:MM` |

**`formatMetricValue` 的输出（按 `unit` 显式分支，无任何换算入参）**：

| unit | 规则 | 例 |
| --- | --- | --- |
| `percent` | `toFixed(1)` + `%` | `12.4%` |
| `bytes` | 复用 `lib/format.ts` 的 `formatBytes(value, 1)`（1024 进制） | `512 B` / `1.5 KB` / `3.5 MB` / `2.0 GB` |
| `ratio` | `value * 100` 后 `toFixed(1)` + `%` | `87.5%` |

- 非法值（`null` / `undefined` / `NaN` / `±Infinity`）一律返回 `—` ——
  **绝不**把 `undefined` 渲染成 `NaN`。
- **没有单位转换入参**是刻意的：把 `12.4` 当成 12.4 字节、或把字节数按 100 折算百分比，
  这类错误**不抛异常**，只会画出一条看起来合理的错误曲线，最难发现。
  所以函数按 `unit` 分支，调用方**没有**"换个单位再算"的可能。

### 11.2 `hooks/useMetricsHistory.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `MetricsHistoryQuery` | `{ metric: string \| null; target: string \| null; range: MetricRange }` | `target` 为 `null` = 未选定目标 |
| `useMetricsHistory` | `(query, { refreshIntervalMs? } = {}) => AsyncState<MetricHistoryView \| null>` | 一条曲线一个请求；默认 **60s** 刷新 |
| `useMetricTargets` | `(metric: string \| null) => AsyncState<MetricTargetOption[]>` | 按 `targetKind` 推导可用目标 |

- **`metric` 或 `target` 缺一就不发请求**，`load` 直接返回 `null`：
  那注定是一次 400，**空态比错误态更诚实**（`immediate: Boolean(metric && target)`）。
- 默认 60s 刷新而不是更短：`1h/24h` 窗口的后端采样是 30s 级，
  更频繁地重取不会带来更多信息，只会增加库读取。
- 目标列表的来源（**全部是 Sprint 1 已冻结的端点**，而不是未冻结的 catalog）：
  `host` → 常量 `host`；`disk` → `/api/system/snapshot` 的 `disks[].label`
  （`label === ''` 的磁盘**不列出来** —— target 必须是稳定身份，不能靠位置猜）；
  `container` / `service` → `/api/services` 的 `sourceRef`
  （§1 明确"容器的 target 与 Sprint 1 的服务身份同源，重启容器不换 target"）。
  容器目标只取 `container !== null` 的项。

### 11.3 `components/MetricPicker.tsx`

纯展示组件：目录、目标列表都由页面传入，因此**不需要 fetch 就能单测**。

| props | 类型 | 说明 |
| --- | --- | --- |
| `value` | `{ metric; target; range }` | 当前选择 |
| `targets` | `readonly MetricTargetOption[]` | 由页面用 `useMetricTargets` 取 |
| `targetsLoading?` | `boolean` | 目标下拉禁用 + 转圈 |
| `onChange` | `(next: MetricPickerValue) => void` | 只回调意图，取数与目标重置由页面负责 |

- 固定 id：`#metric-key` / `#metric-target` / `#metric-range`（E2E 与单测依赖稳定选择器，
  与 `ServiceForm` 的 `#service-name` 同一理由）。
- **切换指标时把 `target` 清空**（`onChange({ ...value, metric: 新值, target: '' })`）：
  `metric × target` 才是曲线的身份，`host.cpu.percent` 的 `host`
  与 `host.disk.percent` 的 `disk:C:` 完全不是一回事；沿用旧目标会得到 400，
  或更糟 —— 一个看似成功的空曲线。
- 目标值为空、或当前 `target` 不在选项里时，`<select>` 显示空选项并
  `disabled`（没有可用目标时给 `（没有可用目标）`）。

### 11.4 `components/MetricsChart.tsx`（手写 SVG，零依赖）

**纯函数（单测入口）**

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `ChartPoint` | interface | 图表只需要 `at/value/partial/samples/expected` 与可选 `min/max` |
| `ValueScale` / `TimeScale` | 类型 | 值 → Y 像素；ISO 时间 → X 像素 |
| `ChartPointNode` / `ChartSegment` / `ChartSeries` | interface | `ChartSeries` = `{ complete, partialSegments, nodes }` |
| `bucketSeconds` | `(at: string) => number` | ISO → unix 秒；非法时间 → `NaN`（由调用方过滤） |
| `buildSeriesSegments` | `(points, resolutionSec, xScale, yScale) => ChartSeries` | 切**连续段**：段内相邻点间距 ≤ resolution |
| `segmentToPath` | `(segment) => string` | `M x,y L x,y …`；**单点段退化为 `M x,y`**（组件用圆点补） |
| `segmentAreaPath` | `(segment, baseY) => string` | 折线封底面积路径（渐隐填充） |
| `buildSeriesPath` | `(points, resolutionSec, xScale, yScale) => { segments; partialSegments }` | 测试直接断言的入口 |
| `niceTicks` | `(min, max, count = 4) => number[]` | 1/2/2.5/5/10 × 10ⁿ 的整刻度，最多 8 个 |
| `formatAxisSeconds` | `(sec, resolution) => string` | 本地时区刻度文案 |
| `formatAxisTick` | `(at, resolution) => string` | ISO 版，内部转 `bucketSeconds` |

**边界条件（这些是"为什么"）**

1. **缺口判据是「间距 > `resolutionSec`」，不是下标差**：缺测就是**没有行**，
   不存在的桶不占下标 —— 用下标差根本看不出缺测。间距**正好等于** resolution
   （相邻桶）必须连成一段，`> resolution` 才断。
2. **非法点直接丢掉**（时间或数值非有限）：宁可少画一段，也不能把 `NaN` 写进 SVG `path`。
3. **乱序输入按时间升序排序后再切片**（缺口判定依赖顺序），且**不修改入参**、不读时钟、不碰 DOM。
4. **含 `partial` 桶的连续段整段换成虚线 + 更浅颜色**（`partialSegments`），
   **段内不断开**：`partial` 桶**是有数据的**（只是样本不足），在它两侧断开
   会让图看起来像缺测 —— 那是另一种谎言。这些桶另外画成**空心琥珀圆点**。
5. `niceTicks` 对**全平序列**（例如健康占比恒为 1）给一个 ±10% 的对称假想范围，
   否则刻度会退化成一个点；非法输入返回 `[]`（组件再退化为 `[lo, hi]`）。
   刻度取整而不取数据最值的理由：真实值常是 `12.4371` 这种数字，
   直接做轴标签会变成一列噪声。

**组件**

```ts
MetricsChartProps = { view: MetricHistoryView | null; loading?: boolean; error?: string | null; onRetry?: () => void }
```

- 几何常量：`WIDTH 760` / `HEIGHT 260` / `PAD { top:16, right:16, bottom:30, left:76 }`；
  **`MAX_INTERACTIVE_NODES = 1500`**（超过就不渲染逐桶命中区，避免上千个透明 rect；
  图表仍完整可用，只是没有逐桶 tooltip）；
  **`MAX_KEYBOARD_NODES = 60`**（只有点数够少时才把每个命中区做成
  `tabIndex=0` + `role="button"` + `aria-label` 的 tab 停靠点，否则键盘反而不可用）。
- 四种状态：`error` → `ErrorNotice`；`view === null` → 加载/骨架卡；
  `summary.count === 0 || nodes.length === 0` → **诚实空态**；否则画布。
- **空态连 `<svg>` 与 `<path>` 都不渲染**（`data-testid="metrics-chart-canvas"` 为 `null`）：
  空态里放图标就会有一个 `<svg>`，"没有曲线"这件事在测试里就无法直接断言；
  更重要的是 —— **画一条 0 的平线就是在说谎**（"没有数据"不等于"值为 0"）。
  空态文案：标题 `还没有历史数据`，描述
  `后台采样每 N 秒一次；重启 HomePort 后历史会保留；缺测处会断开，不补 0。`
  （`N` 取 `view.sampling.intervalSec`，即真实采样间隔，不是写死的数字）。
- **四项标注缺一不可**（计划 S2-02 原文要求，渲染成 `<dl>`）：
  `单位`（`metricUnitLabel`）、`数据源`（`source.mode` + `source.detail`，
  `available === false` 时明确写成 `不可用：…` 并标红）、
  `采样方式`（`sampling.note` **原样透出**）、
  `窗口内缺测`（`整桶缺测 N 个 · 部分缺测 M 个`）。空态也照样标注缺测桶数 ——
  没有数据时"缺了多少"才是最有用的信息。
- 无障碍与断言点：画布 `role="img"` + `aria-label`
  （含指标名、目标、范围、聚合方式、点数、单位、两类缺测数）；
  tooltip `data-testid="metrics-chart-tooltip"` + `aria-live="polite"`，
  内容为时间 / 值（带单位）/ `samples/expected 样本`（`partial` 时补 `（部分缺测）`）/
  桶内 min–max 区间与桶宽；`partial` 段带 `data-partial-segment="true"` 与
  `stroke-dasharray="5 4"`；命中区带 `data-bucket-index`。
- tooltip 的样本数写成 `2/2 样本`、`1/2 样本（部分缺测）`：
  **样本数本身就是数据质量**，只显示一个值读者无法判断这条线可不可信。

### 11.5 `pages/HistoryPage.tsx`

| 项 | 值 | 说明 |
| --- | --- | --- |
| 默认选择 | `{ metric: 'host.cpu.percent', target: '', range: '24h' }` | 目录第一项，任何环境都有 `host` 目标 |
| `emptyTargetHint(kind)` | `disk` / `container` / `service` / 其它 | 四种**可操作**的排障提示（例如"确认 `PORTAL_DISK_MOUNTS` 指向的挂载点可访问"），而不是一句"没有数据" |
| 自动选中 | `useEffect` | 目标列表到位后，若当前选择不在列表里就选**第一个**；已在列表里则**不动**（避免来回跳） |
| 无目标分支 | `targetsState.loaded && !loading && targets.length === 0` | 显示"没有可用的目标"卡，**不渲染图表** |
| 刷新按钮 | 文案 `刷新`，`disabled = history.loading \|\| target === ''` | 与页头副标题"缺测处断开，不补 0"一起说明取数语义 |

页面只做三件事：管住"查什么"的状态、把目标列表选好、把四类状态交给 `MetricsChart`。
它本身**不解析响应、不做单位换算、不裁剪缺测** —— 那些都在 §11.1/§11.4。

**测试**：`web/tests/metricsChart.test.tsx`（缺口断开 2 段、`= resolution` 不算缺口、
非法点不产生 `NaN`、partial 段实为 `5 4` 虚线、`percent`/`bytes` 绝不互换、
空态零 `<path>` 且文案含采样与保留说明、四项标注齐全、`aria-label` 与 tooltip 样本数、
`HistoryPage` 切换指标后目标重新推导并按 `disk%3AC%3A` 重取）。

## 12. 告警（Sprint 2 · S2-04）

**契约来源**：`docs/sprint2-implementation-spec.md` §5.1（阈值校验范围）、
§2.4（episode 模型）、§7（列表与聚合端点的外层形状）、§8（前端要求）。

### 12.1 `api/alerts.ts`（契约镜像 + 展示文案）

| 导出 | 签名 / 形态 | 说明 |
| --- | --- | --- |
| `AlertKind` | `'disk_percent' \| 'memory_percent' \| 'container_exit' \| 'service_health'` | 四种规则类型，改名等于改契约 |
| `AlertSeverity` | `'warning' \| 'critical'` | 严重度 |
| `AlertEventState` | `'open' \| 'resolved'` | 事件展示状态（`resolvedAt` 是否有值） |
| `AlertEventQueryState` | `'all' \| 'open' \| 'resolved'` | `?state=` 的取值 |
| `AlertEventUnit` | `'percent' \| 'exit_code' \| 'count'` | 事件取值单位 |
| `AlertRuleView` | interface | §7 字段清单，与 `alert_rules` 表一一对应（不含内部列） |
| `AlertRuleListResponse` | `{ items: AlertRuleView[] }` | 列表端点统一 `{ items }` |
| `AlertRulePatch` | `{ enabled?; threshold?; durationSec?; silenceSec?; notifyRecovery?; target? }` | 六种可写字段，见 §12.4 的说明 |
| `AlertEventView` | interface | §7 示例逐字段（含 `reopenCount` / `acknowledgedAt` 等） |
| `AlertEventsResponse` | `{ items; total; counts }` | `counts` = `{ open, resolved, unacknowledged }` |
| `AlertSummaryTopItem` | `{ id; ruleName; targetLabel; severity; firedAt }` | `summary.top` 是**轻量投影**，不是完整事件 |
| `AlertSummaryView` | `{ open; unacknowledged; suppressed; bySeverity; top; evaluatedAt }` | **聚合对象本身，不是列表** |
| `EMPTY_ALERT_COUNTS` | `{ open: 0, resolved: 0, unacknowledged: 0 }` | 界面默认值，**不是**解析兜底 |
| `describeAlertKind` | `(kind: string) => string` | 类型 → 中文；未知值**原样透出**（便于排障） |
| `describeSeverity` | `(severity: string) => { label; tone }` | `critical → { 严重, bad }`，否则 `{ 警告, warn }`（与 `ui.tsx` 的 `Tone` 对齐） |
| `formatAlertValue` | `(value, unit: AlertEventUnit \| null) => string` | 取值按单位显示，见下 |
| `describeDuration` | `(seconds: number) => string` | `立即触发` / `N 秒` / `N 分钟` / `N 小时` / `N 天` |
| `ruleThresholdText` | `(rule: AlertRuleView) => string` | 阈值按 kind 说人话 |

- **没有"宽容解析"是刻意的**（§7 补冻结时的明确要求）：契约冻结之后，
  `ruleListFrom()` 之类的归一化会把"服务端少包一层 `items`"变成
  "页面看起来正常但规则一条都不显示" —— 把契约违约伪装成静默兼容，比直接炸掉更难排查。
- `formatAlertValue`：`percent` → `formatPercent`（`91.2%`）、
  `exit_code` → `退出码 0`、`count` → `3 次`；
  **单位缺失时只显示数字本身，绝不猜单位**（猜错就是错的运维结论）；
  非法值 → `—`。
- `ruleThresholdText` 对 `container_exit` **不写 `0%`**，而是
  `固定 0（非 0 退出码即触发）` —— 阈值 0 的语义不是"0%"，
  写成百分比会完全误导；`service_health` 写 `连续 N 次`；前两者写 `N%`，
  未设置写 `未设置`。

### 12.2 `hooks/useAlertSummary.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `EMPTY_ALERT_SUMMARY` | `AlertSummaryView` 零值 | 未取到数据时的界面默认值（徽标不显示） |
| `AlertSummaryState` | interface | `{ open, unacknowledged, suppressed, evaluatedAt, loading, loaded, error, reload }` |
| `useAlertSummary` | `({ enabled?, refreshIntervalMs? } = {}) => AlertSummaryState` | 默认 `enabled = true`、`refreshIntervalMs = 60_000` |

- 单独一个 hook 的理由：徽标活在 `AppShell` 里（**每个页面都渲染**），
  它要的是"一个很小的数字"，不该让每个页面都拉完整的事件列表；
  `GET /api/alerts/summary` 正是为此存在的 viewer 可读端点。
- **`enabled: false` 时不发请求**（`immediate` 为假、刷新间隔置 0），
  直接返回零值视图。`AppShell` 在 404 页也会渲染，那时没有会话。
- **`keepPreviousData: true`**：刷新失败时保留上一次计数 ——
  徽标闪一下消失比稍微旧一点更糟。

### 12.3 `components/AlertEventList.tsx`

| props | 类型 | 说明 |
| --- | --- | --- |
| `items` | `readonly AlertEventView[]` | 空数组 → 空态 |
| `isAdmin` | `boolean` | **只有 admin 才渲染「确认」按钮与「操作」列** |
| `acknowledgingId?` | `string \| null` | 正在确认的事件 id（该行按钮转为 `确认中…` 并 `disabled`） |
| `onAcknowledge` | `(event: AlertEventView) => void` | 回调给页面发 ack |

- 语义化 `<table>`，`<caption class="sr-only">` = `告警事件列表：规则、目标、取值、状态与确认情况`；
  列：`严重度` `规则 / 目标` `取值` `状态` `触发时间` `重开` `确认` `[操作]`。
- 每行带 `data-alert-event-id` / `data-alert-state`（E2E 的稳定断言点）。
- **恢复状态与重开次数必须可见**：只显示一句 `message` 会把这两件事藏起来。
  - 未恢复：`未恢复` 徽标（`critical` 用 `bad` tone，其余 `warn`，带 `dot pulse`）
    + `自 <相对时间>`；
  - 已恢复：`已恢复` 徽标 + `<相对时间>`（`title` 给绝对时间）；
  - `reopenCount > 0` → `重开 N 次`（琥珀色），否则 `—`；
  - 确认列：`已确认 · <绝对时间>`（`title` 写"由 X 确认"）或 `未确认`。
- 取值列：`<值>`，阈值非 null 时补 `/ 阈值 <值>`（同样按 `unit` 格式化，
  所以 `percent` 事件显示成 `91.2% / 阈值 85.0%`）。
- **viewer 不渲染任何写入口**：确认按钮只在 `isAdmin` 时出现，
  已确认的行连按钮都不渲染（显示 `—`）。后端仍会独立拒绝（403），
  前端隐藏只是避免误导。
- 空态：标题 `还没有告警事件`，描述说明"内置四条规则默认关闭（装了但不吵）"——
  空列表的原因是**功能被有意关着**，不是坏了。

### 12.4 `components/AlertRuleForm.tsx`（admin 专用）

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `RuleFieldSpec` | interface | `{ threshold: 'percent' \| 'count' \| 'fixed'; duration: boolean; thresholdMin; thresholdMax; thresholdInteger }` |
| `ruleFieldSpec` | `(kind: AlertKind) => RuleFieldSpec` | §5.1 的范围，逐条对应用户能看到的输入 |
| `RuleDraft` | `{ enabled; threshold; durationSec; silenceSec; notifyRecovery }` | 数字已解析；解析失败为 `NaN`，由校验器报错 |
| `validateRuleDraft` | `(kind, draft) => Record<string, string[]>` | 本地校验，返回 字段 → 错误文案 |
| `rulePatchFrom` | `(rule, draft) => AlertRulePatch` | 只保留**相对原规则有改动**的字段 |
| `AlertRuleForm` | `({ rule, onSaved, onCancel }) => ReactNode` | 表单本体 |

**按 kind 的字段规格**（与 §5.1 同源）：

| kind | threshold | duration | 本地校验 |
| --- | --- | --- | --- |
| `disk_percent` / `memory_percent` | `percent`，0 < t ≤ 100 | 可编辑（0–86400） | 非数字 / 越界 → `阈值必须大于 0 且不超过 100（单位 %）` |
| `service_health` | `count`，整数 1–10 | **不可编辑**（瞬时判定） | 非整数 → `阈值必须是整数`；越界 → `阈值必须在 1–10 之间` |
| `container_exit` | `fixed`（**不给输入控件**） | **不可编辑** | 无阈值校验；界面写 `固定为 0：非 0 退出码即触发` |

- `silenceSec` 三种 kind 都可编辑，范围 **60–604800**（7 天），
  越界文案 `静默周期必须在 60–604800 秒（7 天）之间`。
- **只发送改动过的字段**（`rulePatchFrom`）：某字段等于原值就不进 patch。
  "把字段改回默认"与"从未碰过该字段"因此语义分明，也避免整行回写覆盖别人的改动；
  **patch 为空则根本不发请求**（空 PATCH 只会污染审计日志）。
- 稳定 id（E2E/单测寻址）：`alert-rule-<ruleId>-enabled` /
  `-threshold` / `-duration` / `-silence` / `-notify-recovery`；
  每项的提示文案 id 是 `<字段id>-hint`、错误块 id 是 `<字段id>-error`（`role="alert"`），
  输入框以 `aria-describedby` 同时指向两者、`aria-invalid` 标出错误态。
- 可访问名：`启用` `阈值` `持续时长` `静默周期` `恢复通知`（均为 `<label htmlFor>` 关联）
  与按钮 `取消` / `保存`（提交中为 `保存中…`）。
- `canSubmit = 本地校验无错 && fieldErrors 无错`；保存按钮
  `disabled = submitting || !canSubmit`。**本地先拦**的理由：后端拒绝是底线，
  让用户在点保存前就看见"阈值必须 ≤ 100"才是体验（越界不静默截断）。
- 字段级错误两处都显示：顶部 `ErrorNotice`（请求级）+ 字段级 `role="alert"`。
- **严重度（`severity`）不在可写字段里**：`AlertRulePatch` 只有
  `enabled/threshold/durationSec/silenceSec/notifyRecovery/target`，
  表单只**展示**严重度、不提供编辑控件 —— 与后端 PATCH 的可写集合严格一致。

### 12.5 `pages/AlertsPage.tsx`

| 项 | 实现 |
| --- | --- |
| 事件过滤 | `STATE_FILTERS` = `全部` / `未恢复` / `已恢复`，按钮带 `aria-pressed`，切换即改 `?state=` |
| 事件取数 | `api.alertEvents({ state, limit: 100 })`，`useAsync` 默认 **30s** 刷新 |
| 规则取数 | `api.alertRules()`，**60s** 刷新；`rules.data?.items ?? []` |
| 计数条 | `未恢复 N`（`open > 0` 时 `warn` + `pulse`）/ `已恢复 N` / `未确认 N`（`> 0` 时 `bad`）—— **viewer 也能看** |
| viewer 提示 | `只读视角：修改规则与确认告警需要管理员权限`（仅非 admin 渲染） |
| 规则表 | `data-testid="alert-rules"` 容器，行带 `data-alert-rule-id`；`<caption class="sr-only">` = `告警规则列表：类型、开关状态、阈值、持续时长与静默周期` |
| 规则状态文案 | `启用中`（`ok` 徽标 + dot）/ `已关闭`（`idle` 徽标）。**注意是"已关闭"，不是"未启用"** |
| 编辑入口 | 按钮 `编辑规则`，`aria-label` = `编辑规则 <规则名>`；点击后打开 `Modal` |
| 弹窗 | 标题 `编辑规则：<规则名>`，描述"改动只提交被修改过的字段（PATCH 部分更新）"；`onSaved` 关闭弹窗并 `rules.reload()` |
| 确认 | `submit(async () => { await api.acknowledgeAlertEvent(id); await events.reload(); })`——**不做乐观更新**，计数与"已确认"列必须来自服务端 |
| 刷新按钮 | 文案 `刷新`，`disabled = events.loading` |

**为什么 viewer 也能看到规则列表**：`GET /api/alerts/rules` 在 §7 里就是
**viewer 角色**端点 —— 只读展示不泄露敏感信息，而"规则长什么样"
恰恰是理解告警的必要上下文；写入口（PATCH / ack）才是 admin 专属。

**测试**：`web/tests/alertsPage.test.tsx`（9 条）—— viewer 无任何规则写入口、
admin 改阈值 → `PATCH` 只含改动字段且带 CSRF、越界阈值本地拦住且不发请求、
确认 → `POST …/ack` 并重取、过滤带 `state` 参数、
`reopenCount`/恢复状态/取值单位都在行里渲染、导航徽标取 `unacknowledged`。

### 12.6 可访问名与"viewer 看不到写入口"的断言纪律

E2E（`e2e/smoke.spec.ts`）与单测都按**精确可访问名**断言，不用宽泛正则：

| 断言 | 精确名 |
| --- | --- |
| 确认按钮 | `确认`（E2E 用 `{ name: '确认', exact: true }`，`toHaveCount(0)`） |
| 保存 / 取消 | `保存` / `取消`（同样 `exact: true`） |
| 编辑规则 | `/^编辑规则/`（**锚定开头**：`aria-label` 是 `编辑规则 <规则名>`） |
| 单测里更彻底 | `within(rulesCard).queryAllByRole('button')` 与 `queryAllByRole('checkbox')` 长度都必须为 0 |

**为什么不能用 `确认|保存|启用` 这类宽泛正则**：页面上存在**状态文案**
（规则表的 `启用中` / `已关闭`，安全页的 `未启用`）与 `确认` 列文案
（`已确认 · …` / `未确认`）。宽泛正则会命中这些文本，
测试就会因为"文案恰好像一个按钮"而假失败 —— 那是测试自己的问题，
不是权限问题，会掩盖真正的越权回归。

## 13. 开发与构建

| 命令 | 说明 |
| --- | --- |
| `npm run dev:web` | Vite dev server（`:5273`），`/api` 代理到 `PORTAL_DEV_API`（默认 `http://127.0.0.1:8899`） |
| `npm run build:web` | 产出 `web/dist`，由后端 `@fastify/static` 托管（同源，无 CORS） |
| `npm run typecheck` | 前后端类型检查 |

**测试**（`web/tests/`，`npm run test:web`，Vitest + jsdom，**当前 10 个文件 / 172 用例**，
全部用 `vi.stubGlobal('fetch', …)` 造假响应、不发真实请求）：

| 文件 | 覆盖 |
| --- | --- |
| `client.test.ts` | CSRF 注入、错误体转换、非 JSON 响应、401 回调、超时与网络失败 |
| `components.test.tsx` | 原子组件文案/类名/`aria-*`/回调 |
| `format.test.ts` | 展示格式化 |
| `totp.test.tsx` | 两步登录切换与挑战令牌不落存储、`TOTP_INVALID` 就地报错、`TOTP_CHALLENGE_EXPIRED` 退回第一步、启用流程的一次性恢复码、管理员强制重置、TOTP 接口契约与 401 语义 |
| `metricsChart.test.tsx`（S2-02） | `buildSeriesPath` 缺口断开（`> resolution` 才断、`= resolution` 连接）、乱序排序、非法点不产生 `NaN`；partial 段虚线 `5 4` + 空心点；`percent`/`bytes`/`ratio` 格式化**绝不互换**且非法值 → `—`；`niceTicks` 3–5 个有限刻度；空态零 `<path>` 且文案含采样/保留/断开说明、空态仍报缺测桶数；四项标注齐全、数据源不可用如实标注；`role="img"` 的 `aria-label` 与 tooltip 样本数 `1/2 样本（部分缺测）`；X 轴刻度按 resolution 变；`HistoryPage` 切换指标后目标改从 `/api/system/snapshot` 推导并按 `disk%3AC%3A` 重取 |
| `alertsPage.test.tsx`（S2-04） | viewer 看得到事件/计数/只读规则，但规则卡里 **0 个 button、0 个 checkbox**、无 `确认` 与 `编辑规则`；admin 改阈值 → `PATCH` 请求体只含改动字段并带 `x-csrf-token`，保存后关弹窗并重取；越界阈值本地拦住（`role="alert"` + `aria-invalid` + 保存禁用 + 零请求）；`确认` → `POST …/ack` 并重取事件；过滤切换带 `state` 且 `aria-pressed`；行内渲染 `未恢复`/`已恢复`/`重开 N 次`/`未确认` 与按 `unit` 格式化的取值与阈值；导航徽标取 `unacknowledged`（不是 `open`）、0 不渲染、`suppressed` 写进 `title` |

> 上表**未逐条列出** Sprint 1 的 `adminServices.test.tsx`、`commandPalette.test.tsx`、
> `services.test.tsx`、`serviceForm.test.tsx`（Sprint 1 收尾时未补进本节）——
> 加上它们才是"10 个文件"的完整构成。本表按 `git diff` 归档，故本次只新增 S2 的两行。

**缓存策略**：`/assets/*`（文件名含 hash）长缓存 `immutable`；
`index.html` 强制 `no-cache`，保证发版后立即生效。
