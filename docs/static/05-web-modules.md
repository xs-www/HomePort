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
│   ├── types.ts              # 与后端契约逐字段对应的类型
│   └── client.ts             # ApiClient / ApiError / api 单例
├── auth/AuthProvider.tsx     # 会话、偏好、主题、CSRF 注入
├── hooks/
│   ├── useAsync.ts           # useAsync / useSubmit / useLocalState
│   └── useMetricsStream.ts   # SSE 订阅
├── lib/format.ts             # 展示格式化（与后端 util/format 职责互补）
├── components/ui.tsx         # Badge / Card / ProgressBar / StatCard / ...
├── layout/
│   ├── AppShell.tsx          # 侧边导航 + 顶栏 + 内容区
│   └── Shell.tsx             # AppShell 的薄包装（供页面直接使用）
└── pages/                    # 7 个页面 + 404
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
| `login` | `({username,password,remember}) => Promise<LoginResponse>` | 跳过 401 回调（否则登录失败会触发"会话失效"逻辑） |
| `logout` / `bootstrap` / `changePassword` / `sessionActivity` | — | 认证 |
| `overview` | `() => Promise<OverviewResponse>` | 慢接口超时 |
| `containers` / `container` / `containerLogs` | — | 容器 |
| `tailnetDevices` / `tailnetStatus` | — | tailnet |
| `systemSnapshot` | — | 系统 |
| `tools` / `probeTool` | — | 工具 |
| `me` / `updatePreferences` / `users` / `createUser` / `updateUser` / `deleteUser` / `resetUserPassword` / `revokeUserSessions` / `auditLog` | — | 用户 |

`toApiError(payload, status)` 把后端错误体转成 `ApiError`；无法识别时按状态码给中文兜底文案。

## 4. `auth/AuthProvider.tsx`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `AuthContextValue` | interface | 见下 |
| `AuthProvider` | `({children}) => ReactNode` | 创建并持有一个 `ApiClient`，把 CSRF 取值与 401 处理注入其中 |
| `useAuth` | `() => AuthContextValue` | 必须在 Provider 内 |
| `useApi` | `() => ApiClient` | 取同一实例（保证 CSRF 一致） |
| `applyTheme` | `(theme: 'dark'\|'light'\|'system') => void` | 切换 `<html class="dark">` 与 `color-scheme` |

`AuthContextValue`：`api` `ready` `user` `preferences` `setupRequired` `apiVersion`
`login` `bootstrap` `logout` `refresh` `updatePreferences` `isAdmin`

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
- 导航项由 `NAV_ITEMS` 定义，"账号管理"带 `adminOnly`，对 viewer 隐藏。

**`Shell.tsx`** — `Shell(props)`，`AppShell` 的薄包装。
页面内部使用它而不是在 `App.tsx` 里包，原因：守卫需要直接 `return <Navigate>`
（此时导航栏会消失），把外壳放在页面内可保证任何守卫分支都不丢导航。

## 9. `pages/`

| 页面 | 路由 | 数据来源 | 要点 |
| --- | --- | --- | --- |
| `LoginPage` | `/login` | `useAuth().login` | 不做"忘记密码"（本地账号体系无邮件通道），明确提示联系管理员 |
| `SetupPage` | `/setup` | `useAuth().bootstrap` | 需首启令牌；密码二次确认；已初始化时显示引导而非报错 |
| `OverviewPage` | `/` | `/api/overview` + SSE | 四张指标卡、硬件进度条、在线设备、featured 工具、数据源告警 |
| `ContainersPage` | `/containers` | `/api/containers` | 容器墙；搜索 + 可达性过滤 + 含已停止 + 实时占用开关（筛选条件持久化） |
| `ContainerDetailPage` | `/containers/:id` | `/api/containers/:id` + `/logs` | 基础信息、实时占用、端口表（含可达性）、备选入口、挂载、脱敏环境变量、日志（可选行数） |
| `DevicesPage` | `/devices` | `/api/tailscale/devices` | 设备表；搜索、只看在线、多种排序、点击复制 IP |
| `SystemPage` | `/system` | `/api/system/snapshot` + SSE | CPU（含各核心热力条）、内存、GPU（含占用进程）、磁盘；每个数据源标注取数模式 |
| `ToolsPage` | `/tools` | `/api/tools` | 工具卡；状态过滤、分类过滤、单工具强制探测、多候选入口折叠 |
| `AdminPage` | `/admin` | `/api/users*` | 三个标签页：用户与权限、审计日志、安全与偏好 |
| `NotFoundPage` | `*` | — | 404 |

**容器的可点击入口渲染规则**：只有 `port.url !== null`（即判定为 `tailnet`/`lan`）才渲染成链接；
`localhost-only` / 未发布的端口在卡片上以灰底文字说明原因，避免"点了打不开"的困惑。

## 10. `App.tsx` 守卫

| 组件 | 行为 |
| --- | --- |
| `BootScreen` | 会话探测期间的全屏加载态（避免闪屏） |
| `Protected` | `!ready` → `BootScreen`；`setupRequired` → `/setup`；未登录 → `/login`（记录来源路径） |
| `AdminOnly` | 非 admin → `ForbiddenPage`（后端也会独立拒绝） |
| `GuestOnly` | 已登录访问 `/login` → 跳回来源页；`setupRequired` → `/setup` |

## 11. 开发与构建

| 命令 | 说明 |
| --- | --- |
| `npm run dev:web` | Vite dev server（`:5273`），`/api` 代理到 `PORTAL_DEV_API`（默认 `http://127.0.0.1:8899`） |
| `npm run build:web` | 产出 `web/dist`，由后端 `@fastify/static` 托管（同源，无 CORS） |
| `npm run typecheck` | 前后端类型检查 |

**缓存策略**：`/assets/*`（文件名含 hash）长缓存 `immutable`；
`index.html` 强制 `no-cache`，保证发版后立即生效。
